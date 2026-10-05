import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolView } from "@/views/ToolView";
import { providersApi, type ProviderSwitchEvent } from "@/lib/api/providers";
import { toast } from "sonner";
import type { Provider } from "@/types";
vi.mock("@/lib/api/providers", () => ({
  providersApi: {
    getAll: vi.fn(),
    getCurrent: vi.fn(),
    onSwitched: vi.fn(),
    addAndActivate: vi.fn(),
    switch: vi.fn(),
    removeFromLiveConfig: vi.fn(),
    openTerminal: vi.fn(),
    importDefault: vi.fn(),
    importOpenCodeFromLive: vi.fn(),
    importOpenClawFromLive: vi.fn(),
    importHermesFromLive: vi.fn(),
  },
}));
vi.mock("@/components/settings/AboutSection", () => ({
  AboutSection: () => null,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(providersApi.getAll).mockResolvedValue({});
  vi.mocked(providersApi.getCurrent).mockResolvedValue("");
  vi.mocked(providersApi.onSwitched).mockResolvedValue(vi.fn());
  vi.mocked(providersApi.addAndActivate).mockResolvedValue(true);
  vi.mocked(providersApi.importDefault).mockResolvedValue(true);
  vi.mocked(providersApi.importOpenCodeFromLive).mockResolvedValue(1);
  vi.mocked(providersApi.importOpenClawFromLive).mockResolvedValue(1);
  vi.mocked(providersApi.importHermesFromLive).mockResolvedValue(1);
  vi.mocked(providersApi.switch).mockResolvedValue({
    warnings: [],
    routingChanged: false,
  });
});
describe("native tool official entry", () => {
  it.each([
    ["claude-code", "Claude Code", "claude"],
    ["gemini-cli", "Gemini CLI", "gemini"],
    ["opencode", "OpenCode", "opencode"],
  ])(
    "opens resources for the selected %s tool",
    async (toolId, name, appId) => {
      const onManageResources = vi.fn();
      render(
        <ToolView toolId={toolId} onManageResources={onManageResources} />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: `管理 ${name} 的 Skills 与 MCP` }),
      );
      expect(onManageResources).toHaveBeenCalledWith(appId);
      await screen.findByText(/浏览器预览未检测安装状态/);
    },
  );

  it.each([
    ["claude-code", "Claude Official", "claude"],
    ["gemini-cli", "Google Official", "gemini"],
  ])(
    "shows an official route for an empty %s database without automatically changing config",
    async (toolId, name, appId) => {
      render(<ToolView toolId={toolId} />);
      expect(await screen.findByText(name)).toBeVisible();
      expect(screen.getByText("0 条线路")).toBeVisible();
      expect(screen.getByText("另有 1 个内置官方入口")).toBeVisible();
      expect(screen.getByText("内置官方入口（未启用）")).toBeVisible();
      expect(providersApi.importDefault).not.toHaveBeenCalled();
      expect(
        screen.getByRole("region", { name: "官方账号登录" }),
      ).toHaveTextContent("此处不代表已登录");
      expect(providersApi.addAndActivate).not.toHaveBeenCalled();
      expect(providersApi.switch).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("button", { name: "当前线路" }),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "切换" }));
      await waitFor(() =>
        expect(providersApi.addAndActivate).toHaveBeenCalledWith(
          expect.objectContaining({
            id: appId + "-official",
            category: "official",
            settingsConfig: expect.objectContaining({ env: {} }),
          }),
          appId,
        ),
      );
    },
  );
  it("does not duplicate a saved official route or claim account login", async () => {
    vi.mocked(providersApi.getAll).mockResolvedValue({
      official: {
        id: "official",
        name: "Saved official",
        category: "official",
        settingsConfig: { env: {} },
      },
    });
    vi.mocked(providersApi.getCurrent).mockResolvedValue("official");
    render(<ToolView toolId="claude-code" />);
    await screen.findByText("Saved official");
    expect(screen.queryByText("Claude Official")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "当前线路" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "打开登录终端" })).toBeVisible();
  });
  it("does not mistake a colliding custom ID for the built-in official route", async () => {
    vi.mocked(providersApi.getAll).mockResolvedValue({
      "claude-official": {
        id: "claude-official",
        name: "Custom route",
        category: "custom",
        settingsConfig: { env: {} },
      },
    });
    vi.mocked(providersApi.getCurrent).mockResolvedValue("claude-official");
    render(<ToolView toolId="claude-code" />);
    await screen.findByText("Custom route");
    expect(screen.getByText("Claude Official")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "切换" }));
    await waitFor(() =>
      expect(providersApi.addAndActivate).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "claude-official-1",
          category: "official",
        }),
        "claude",
      ),
    );
    expect(providersApi.switch).not.toHaveBeenCalled();
  });

  it.each(["opencode", "pi"])(
    "does not show Google login for a saved official %s entry",
    async (toolId) => {
      vi.mocked(providersApi.getAll).mockResolvedValue({
        official: {
          id: "official",
          name: "Saved official",
          category: "official",
          settingsConfig: {},
        },
      });
      vi.mocked(providersApi.getCurrent).mockResolvedValue("official");
      render(<ToolView toolId={toolId} />);
      expect(await screen.findByText("Saved official")).toBeVisible();
      expect(
        screen.queryByRole("region", { name: "官方账号登录" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "打开登录终端" }),
      ).not.toBeInTheDocument();
    },
  );

  it("keeps failed activation visibly inactive", async () => {
    vi.mocked(providersApi.addAndActivate).mockRejectedValue(
      new Error("write denied"),
    );
    render(<ToolView toolId="claude-code" />);
    await screen.findByText("Claude Official");
    fireEvent.click(screen.getByRole("button", { name: "切换" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("配置未更新", {
        description: "write denied",
      }),
    );
    expect(
      screen.queryByRole("button", { name: "当前线路" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "切换" })).toBeEnabled();
  });
  it("does not add an unsupported official login to an accumulate tool", async () => {
    render(<ToolView toolId="pi" />);
    await screen.findByText(/还没有 Pi 线路/);
    expect(
      screen.queryByRole("region", { name: "官方账号登录" }),
    ).not.toBeInTheDocument();
  });
  it("ignores older provider loads when the selected tool changes", async () => {
    let resolveClaude!: (value: Record<string, Provider>) => void;
    vi.mocked(providersApi.getAll).mockImplementation(async (app) =>
      app === "claude"
        ? new Promise((resolve) => {
            resolveClaude = resolve;
          })
        : {},
    );
    const view = render(<ToolView toolId="claude-code" />);
    view.rerender(<ToolView toolId="gemini-cli" />);
    await screen.findByText("Google Official");
    await act(async () => {
      resolveClaude({
        old: { id: "old", name: "Old Claude", settingsConfig: { env: {} } },
      });
    });
    expect(screen.queryByText("Old Claude")).not.toBeInTheDocument();
    expect(screen.getByText("Google Official")).toBeVisible();
  });
  it("surfaces backend warnings and the need to restart an already running tool", async () => {
    vi.mocked(providersApi.getAll).mockResolvedValue({
      official: {
        id: "official",
        name: "Claude Official",
        category: "official",
        settingsConfig: { env: {} },
      },
    });
    vi.mocked(providersApi.switch).mockResolvedValue({
      warnings: ["environment override"],
      routingChanged: false,
    });
    render(<ToolView toolId="claude-code" />);
    await screen.findByText("Claude Official");
    fireEvent.click(screen.getByRole("button", { name: "切换" }));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith("environment override"),
    );
    expect(toast.success).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        description: expect.stringContaining("需重新启动"),
      }),
    );
    expect(providersApi.addAndActivate).not.toHaveBeenCalled();
  });
});

describe("explicit native configuration import", () => {
  it.each([
    ["claude-code", "claude", "importDefault"],
    ["gemini-cli", "gemini", "importDefault"],
    ["grokbuild", "grokbuild", "importDefault"],
    ["opencode", "opencode", "importOpenCodeFromLive"],
    ["openclaw", "openclaw", "importOpenClawFromLive"],
    ["hermes", "hermes", "importHermesFromLive"],
  ] as const)(
    "imports %s only after explicit consent with its own importer",
    async (toolId, appId, method) => {
      render(<ToolView toolId={toolId} native />);
      const button = await screen.findByRole("button", {
        name: "导入本机配置",
      });
      expect(providersApi[method]).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled(),
      );
      expect(providersApi[method]).not.toHaveBeenCalled();
      fireEvent.click(button);
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith(
          "已导入本机配置",
          expect.any(Object),
        ),
      );
      if (method === "importDefault") {
        expect(providersApi.importDefault).toHaveBeenCalledWith(appId);
      } else {
        expect(providersApi[method]).toHaveBeenCalledWith();
        expect(providersApi.importDefault).not.toHaveBeenCalled();
      }
      expect(providersApi[method]).toHaveBeenCalledTimes(1);
      expect(providersApi.addAndActivate).not.toHaveBeenCalled();
      expect(providersApi.switch).not.toHaveBeenCalled();
      expect(providersApi.getAll).toHaveBeenLastCalledWith(appId);
    },
  );

  it("shows the imported third-party endpoint and selection instead of an official-login guide", async () => {
    vi.mocked(providersApi.importDefault).mockImplementation(async () => {
      vi.mocked(providersApi.getAll).mockResolvedValue({
        default: {
          id: "default",
          name: "Local API",
          category: "custom",
          settingsConfig: {
            env: {
              ANTHROPIC_BASE_URL: "https://api.example.test",
              ANTHROPIC_AUTH_TOKEN: "test-only-secret",
              ANTHROPIC_MODEL: "claude-test",
            },
          },
        },
      });
      vi.mocked(providersApi.getCurrent).mockResolvedValue("default");
      return true;
    });
    render(<ToolView toolId="claude-code" native />);
    fireEvent.click(
      await screen.findByRole("button", { name: "导入本机配置" }),
    );
    expect(await screen.findByText("Local API")).toBeVisible();
    expect(screen.getByText("https://api.example.test")).toBeVisible();
    expect(screen.getByText("claude-test")).toBeVisible();
    expect(screen.getByText("1 条线路")).toBeVisible();
    expect(screen.getByRole("button", { name: "当前线路" })).toBeDisabled();
    expect(
      screen.queryByRole("region", { name: "官方账号登录" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("test-only-secret")).not.toBeInTheDocument();
    expect(providersApi.switch).not.toHaveBeenCalled();
    expect(providersApi.addAndActivate).not.toHaveBeenCalled();
  });

  it("reports a skipped import without claiming success or switching routes", async () => {
    vi.mocked(providersApi.importDefault).mockResolvedValue(false);
    render(<ToolView toolId="claude-code" native />);
    fireEvent.click(
      await screen.findByRole("button", { name: "导入本机配置" }),
    );
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        "未导入本机配置",
        expect.any(Object),
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(providersApi.switch).not.toHaveBeenCalled();
  });

  it("does not report empty or unchanged additive imports as success", async () => {
    vi.mocked(providersApi.importOpenCodeFromLive).mockResolvedValue(0);
    render(<ToolView toolId="opencode" native />);
    fireEvent.click(
      await screen.findByRole("button", { name: "导入本机配置" }),
    );
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        "没有需要导入的配置",
        expect.any(Object),
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("keeps existing routes and allows retry after unreadable native config", async () => {
    vi.mocked(providersApi.getAll).mockResolvedValue({
      local: {
        id: "local",
        name: "Existing route",
        settingsConfig: { env: {} },
      },
    });
    vi.mocked(providersApi.importDefault).mockRejectedValue(
      new Error("配置文件无法解析"),
    );
    render(<ToolView toolId="claude-code" native />);
    fireEvent.click(
      await screen.findByRole("button", { name: "导入本机配置" }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("导入本机配置失败", {
        description: "配置文件无法解析",
      }),
    );
    expect(screen.getByText("Existing route")).toBeVisible();
    expect(screen.getByRole("button", { name: "导入本机配置" })).toBeEnabled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("deduplicates pending imports and ignores results after leaving and returning to a tool", async () => {
    let finish!: (value: boolean) => void;
    vi.mocked(providersApi.importDefault).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = render(<ToolView toolId="claude-code" native />);
    const button = await screen.findByRole("button", { name: "导入本机配置" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(providersApi.importDefault).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "正在导入…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "切换" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "刷新" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "添加线路" })).toBeDisabled();
    view.rerender(<ToolView toolId="gemini-cli" native />);
    await screen.findByText("Google Official");
    view.rerender(<ToolView toolId="claude-code" native />);
    await screen.findByText("Claude Official");
    const calls = vi.mocked(providersApi.getAll).mock.calls.length;
    await act(async () => {
      finish(true);
    });
    expect(providersApi.getAll).toHaveBeenCalledTimes(calls);
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "导入本机配置" })).toBeEnabled();
  });

  it("disables credential import in browser previews", async () => {
    render(<ToolView toolId="claude-code" />);
    const button = await screen.findByRole("button", { name: "导入本机配置" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(providersApi.importDefault).not.toHaveBeenCalled();
  });

  it.each(["pi", "mcode"])(
    "does not offer a database import for native-backed %s",
    async (toolId) => {
      render(<ToolView toolId={toolId} />);
      await screen.findByText("原生配置线路");
      expect(
        screen.queryByRole("button", { name: "导入本机配置" }),
      ).not.toBeInTheDocument();
    },
  );
});

describe("Claude Desktop page layout", () => {
  it("places the page heading before setup and removes the obsolete installation warning", async () => {
    render(<ToolView toolId="claude-desktop" />);
    const panel = await screen.findByRole("region", {
      name: "Claude Desktop 配置状态",
    });
    const heading = screen.getByRole("heading", {
      name: "Claude Desktop",
      level: 1,
    });
    expect(
      heading.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "快速安装" })).toBeVisible();
    expect(screen.getByRole("button", { name: "添加线路" })).toBeDisabled();
    expect(
      screen.queryByText(/暂无安装、升级或重启管理/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Claude Desktop 安装与资源管理" }),
    ).not.toBeInTheDocument();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("provider switch subscriptions", () => {
  const lines: Record<string, Provider> = {
    a: { id: "a", name: "Line A", settingsConfig: { env: {} } },
    b: { id: "b", name: "Line B", settingsConfig: { env: {} } },
  };
  const switchButton = (name: string) =>
    within(screen.getByText(name).parentElement!.parentElement!).getByRole(
      "button",
      { name: /^(当前线路|切换)$/ },
    );
  const emit = (event: ProviderSwitchEvent) => {
    const [handler] = vi.mocked(providersApi.onSwitched).mock.calls.at(-1)!;
    act(() => handler(event));
  };

  beforeEach(() => {
    vi.mocked(providersApi.getAll).mockResolvedValue(lines);
    vi.mocked(providersApi.getCurrent).mockResolvedValue("a");
  });

  it("refreshes the selected app after a tray switch and ignores other apps", async () => {
    const dispose = vi.fn();
    vi.mocked(providersApi.onSwitched).mockResolvedValue(dispose);
    const view = render(<ToolView toolId="claude-code" native />);
    await screen.findByText("Line A");
    await waitFor(() => expect(providersApi.getAll).toHaveBeenCalledTimes(2));
    expect(switchButton("Line A")).toBeDisabled();
    emit({ appType: "gemini", providerId: "b" });
    expect(providersApi.getAll).toHaveBeenCalledTimes(2);

    vi.mocked(providersApi.getCurrent).mockResolvedValue("b");
    emit({ appType: "claude", providerId: "b" });
    await waitFor(() => expect(switchButton("Line B")).toBeDisabled());
    expect(switchButton("Line A")).toBeEnabled();
    expect(providersApi.getAll).toHaveBeenCalledTimes(3);
    expect(providersApi.getAll).toHaveBeenLastCalledWith("claude");
    expect(providersApi.switch).not.toHaveBeenCalled();

    view.unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
    emit({ appType: "claude", providerId: "a" });
    expect(providersApi.getAll).toHaveBeenCalledTimes(3);
  });

  it("rereads after async subscription and ignores a stale initial snapshot", async () => {
    const subscription = deferred<() => void>();
    const initial = deferred<Record<string, Provider>>();
    vi.mocked(providersApi.onSwitched).mockReturnValue(subscription.promise);
    vi.mocked(providersApi.getAll).mockReturnValueOnce(initial.promise);
    vi.mocked(providersApi.getCurrent)
      .mockResolvedValueOnce("a")
      .mockResolvedValue("b");
    render(<ToolView toolId="claude-code" native />);
    expect(providersApi.getAll).toHaveBeenCalledTimes(1);
    await act(async () => subscription.resolve(vi.fn()));
    await screen.findByText("Line B");
    expect(switchButton("Line B")).toBeDisabled();
    await act(async () =>
      initial.resolve({ a: { ...lines.a, name: "Stale initial line" } }),
    );
    expect(screen.queryByText("Stale initial line")).not.toBeInTheDocument();
    expect(switchButton("Line B")).toBeDisabled();
  });

  it("keeps the newest event refresh when older requests finish last", async () => {
    render(<ToolView toolId="claude-code" native />);
    await screen.findByText("Line A");
    await waitFor(() => expect(providersApi.getAll).toHaveBeenCalledTimes(2));
    const old = deferred<Record<string, Provider>>();
    vi.mocked(providersApi.getAll).mockReturnValueOnce(old.promise);
    emit({ appType: "claude", providerId: "a" });
    vi.mocked(providersApi.getCurrent).mockResolvedValue("b");
    emit({ appType: "claude", providerId: "b" });
    await waitFor(() => expect(switchButton("Line B")).toBeDisabled());
    await act(async () => old.reject(new Error("stale read failed")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(switchButton("Line A")).toBeEnabled();
    expect(switchButton("Line B")).toBeDisabled();
  });

  it.each(["unmount", "leave and return"])(
    "disposes a late subscription after %s without rereading or accepting old events",
    async (action) => {
      const pending = deferred<() => void>();
      const dispose = vi.fn();
      vi.mocked(providersApi.onSwitched).mockReturnValueOnce(pending.promise);
      const view = render(<ToolView toolId="claude-code" native />);
      await screen.findByText("Line A");
      const [oldHandler] = vi.mocked(providersApi.onSwitched).mock.calls[0];
      if (action === "unmount") {
        view.unmount();
      } else {
        view.rerender(<ToolView toolId="gemini-cli" native />);
        await waitFor(() =>
          expect(providersApi.getAll).toHaveBeenCalledTimes(3),
        );
        view.rerender(<ToolView toolId="claude-code" native />);
        await waitFor(() =>
          expect(providersApi.getAll).toHaveBeenCalledTimes(5),
        );
        await screen.findByText("Line A");
      }
      const reads = vi.mocked(providersApi.getAll).mock.calls.length;
      await act(async () => pending.resolve(dispose));
      expect(dispose).toHaveBeenCalledTimes(1);
      act(() => oldHandler({ appType: "claude", providerId: "b" }));
      expect(providersApi.getAll).toHaveBeenCalledTimes(reads);
    },
  );

  it("surfaces subscription failure while preserving manual refresh", async () => {
    vi.mocked(providersApi.onSwitched).mockRejectedValue(
      new Error("listen failed"),
    );
    render(<ToolView toolId="claude-code" native />);
    await screen.findByText("Line A");
    expect(toast.error).toHaveBeenCalledWith(
      "无法订阅线路切换，请手动刷新或重新加载应用",
    );
    vi.mocked(providersApi.getCurrent).mockResolvedValue("b");
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(switchButton("Line B")).toBeDisabled());
  });

  it("ignores a subscription rejection after unmount", async () => {
    const pending = deferred<() => void>();
    vi.mocked(providersApi.onSwitched).mockReturnValue(pending.promise);
    const view = render(<ToolView toolId="claude-code" native />);
    await screen.findByText("Line A");
    view.unmount();
    await act(async () => pending.reject(new Error("late failure")));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("does not subscribe in a browser preview", async () => {
    render(<ToolView toolId="claude-code" />);
    await screen.findByText("Line A");
    expect(providersApi.onSwitched).not.toHaveBeenCalled();
  });
});

describe("additive live membership", () => {
  it.each(["opencode", "openclaw", "hermes"] as const)(
    "uses backend membership for %s counts and toggle direction without importing",
    async (appId) => {
      vi.mocked(providersApi.getAll).mockResolvedValue({
        absent: {
          id: "absent",
          name: "Absent",
          settingsConfig: {},
          meta: { liveConfigManaged: false },
        },
        present: {
          id: "present",
          name: "Present",
          settingsConfig: {},
          meta: { liveConfigManaged: true },
        },
      });
      render(<ToolView toolId={appId} native />);
      const enable = await screen.findByRole("button", { name: "启用Absent" });
      expect(screen.getByText("1 条已启用")).toBeVisible();
      fireEvent.click(enable);
      await waitFor(() =>
        expect(providersApi.switch).toHaveBeenCalledWith("absent", appId),
      );
      const disable = screen.getByRole("button", { name: "停用Present" });
      await waitFor(() => expect(disable).toBeEnabled());
      fireEvent.click(disable);
      await waitFor(() =>
        expect(providersApi.removeFromLiveConfig).toHaveBeenCalledWith(
          "present",
          appId,
        ),
      );
      await waitFor(() => expect(disable).toBeEnabled());
      expect(providersApi.importOpenCodeFromLive).not.toHaveBeenCalled();
      expect(providersApi.importOpenClawFromLive).not.toHaveBeenCalled();
      expect(providersApi.importHermesFromLive).not.toHaveBeenCalled();
    },
  );

  it.each(["opencode", "openclaw", "hermes"])(
    "shows a %s live read failure instead of retaining an enabled toggle",
    async (appId) => {
      vi.mocked(providersApi.getAll).mockResolvedValue({
        saved: {
          id: "saved",
          name: "Saved",
          settingsConfig: {},
          meta: { liveConfigManaged: true },
        },
      });
      render(<ToolView toolId={appId} native />);
      await screen.findByRole("button", { name: "停用Saved" });
      vi.mocked(providersApi.getAll).mockRejectedValue(
        new Error("invalid live config"),
      );
      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "invalid live config",
      );
      expect(
        screen.queryByRole("button", { name: /(?:启用|停用)Saved/ }),
      ).not.toBeInTheDocument();
      expect(providersApi.switch).not.toHaveBeenCalled();
      expect(providersApi.removeFromLiveConfig).not.toHaveBeenCalled();
    },
  );
});
