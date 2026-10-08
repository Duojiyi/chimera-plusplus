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
import { vscodeApi } from "@/lib/api/vscode";
import { toast } from "sonner";
import type { Provider } from "@/types";
vi.mock("@/lib/api/vscode", () => ({
  vscodeApi: { getLiveProviderSettings: vi.fn() },
}));
vi.mock("@/lib/api/providers", () => ({
  providersApi: {
    getAll: vi.fn(),
    delete: vi.fn(),
    getCurrent: vi.fn(),
    onSwitched: vi.fn(),
    addAndActivate: vi.fn(),
    switch: vi.fn(),
    removeFromLiveConfig: vi.fn(),
    openTerminal: vi.fn(),
    importDefault: vi.fn(),
    importOpenCodeFromLive: vi.fn(),
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
  vi.mocked(vscodeApi.getLiveProviderSettings).mockResolvedValue({
    env: { API_KEY: "discovered-secret" },
  });
  vi.mocked(providersApi.getAll).mockResolvedValue({});
  vi.mocked(providersApi.getCurrent).mockResolvedValue("");
  vi.mocked(providersApi.onSwitched).mockResolvedValue(vi.fn());
  vi.mocked(providersApi.addAndActivate).mockResolvedValue(true);
  vi.mocked(providersApi.importDefault).mockResolvedValue(true);
  vi.mocked(providersApi.importOpenCodeFromLive).mockResolvedValue(1);

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
      expect(toast.error).toHaveBeenCalledWith("Claude Code 配置未更新", {
        description: "请检查本机配置和文件权限后重试。",
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
  ] as const)(
    "imports %s only after explicit consent with its own importer",
    async (toolId, appId, method) => {
      render(<ToolView toolId={toolId} native />);
      const button = await screen.findByRole("button", {
        name: "导入本机配置",
      });
      expect(providersApi[method]).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "刷新线路" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "刷新线路" })).toBeEnabled(),
      );
      expect(providersApi[method]).not.toHaveBeenCalled();
      fireEvent.click(button);
      expect(providersApi[method]).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "确认保存导入" }));
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
    fireEvent.click(screen.getByRole("button", { name: "确认保存导入" }));
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
    fireEvent.click(screen.getByRole("button", { name: "确认保存导入" }));
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
    fireEvent.click(screen.getByRole("button", { name: "确认保存导入" }));
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
      new Error("TOML line: token = secret-test-token"),
    );
    render(<ToolView toolId="claude-code" native />);
    fireEvent.click(
      await screen.findByRole("button", { name: "导入本机配置" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认保存导入" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("导入本机配置失败", {
        description: "请检查本机配置格式和文件权限后重试。",
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
    expect(screen.getByRole("button", { name: "刷新线路" })).toBeDisabled();
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

  it.each(["pi"])(
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
    const panel = await screen.findByRole(
      "region",
      { name: "Claude Desktop 配置状态" },
      { timeout: 10000 },
    );
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
    fireEvent.click(screen.getByRole("button", { name: "刷新线路" }));
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
  it.each(["opencode"])(
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
      fireEvent.click(screen.getByRole("button", { name: "刷新线路" }));
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

describe("read-only local discovery", () => {
  it("keeps read failures separate from saved routes and retries on refresh", async () => {
    vi.mocked(vscodeApi.getLiveProviderSettings).mockRejectedValueOnce(
      new Error("secret parse error"),
    );
    render(<ToolView toolId="claude-code" native />);
    await screen.findByText("未找到或无法读取");
    expect(screen.queryByText("secret parse error")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "刷新线路" }));
    await screen.findByText("已发现配置");
    expect(providersApi.importDefault).not.toHaveBeenCalled();
  });
  it("does not read local settings in browser preview", async () => {
    render(<ToolView toolId="claude-code" />);
    await screen.findByText("桌面端可检测");
    expect(vscodeApi.getLiveProviderSettings).not.toHaveBeenCalled();
  });
  it("discards discovery results after changing tools", async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(vscodeApi.getLiveProviderSettings)
      .mockReturnValueOnce(
        new Promise((r) => {
          resolve = r;
        }),
      )
      .mockResolvedValueOnce({});
    const view = render(<ToolView toolId="claude-code" native />);
    view.rerender(<ToolView toolId="gemini-cli" native />);
    await screen.findByText("未发现配置内容");
    await act(async () => resolve({ env: { key: "old" } }));
    expect(screen.getByText("未发现配置内容")).toBeVisible();
    expect(screen.queryByText("已发现配置")).not.toBeInTheDocument();
  });
});

describe("operation feedback ownership", () => {
  it.each([false, true])(
    "ignores old switch completion after leaving the page (failure: %s)",
    async (fail) => {
      let resolve!: (value: {
        warnings: string[];
        routingChanged: boolean;
      }) => void;
      let reject!: (error: Error) => void;
      vi.mocked(providersApi.switch).mockReturnValue(
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
      );
      vi.mocked(providersApi.getAll).mockResolvedValue({
        saved: { id: "saved", name: "Saved", settingsConfig: { env: {} } },
      });
      const { unmount } = render(<ToolView toolId="claude-code" native />);
      const row = (await screen.findByText("Saved")).parentElement!
        .parentElement!;
      fireEvent.click(within(row).getByRole("button", { name: "切换" }));
      await waitFor(() => expect(providersApi.switch).toHaveBeenCalled());
      unmount();
      await act(async () => {
        if (fail) reject(new Error("old failure"));
        else resolve({ warnings: ["old warning"], routingChanged: false });
      });
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      expect(toast.warning).not.toHaveBeenCalled();
    },
  );
});

it("does not report an empty Gemini wrapper as discovered config", async () => {
  vi.mocked(vscodeApi.getLiveProviderSettings).mockResolvedValue({
    env: {},
    config: {},
  });
  render(<ToolView toolId="gemini-cli" native />);
  expect(await screen.findByText("未发现配置内容")).toBeVisible();
  expect(providersApi.importDefault).not.toHaveBeenCalled();
});

describe("list-level route deletion", () => {
  const route: Provider = {
    id: "delete-me",
    name: "Removable route",
    settingsConfig: {},
  };
  it.each([
    ["claude-code", "claude"],
    ["gemini-cli", "gemini"],
    ["grokbuild", "grokbuild"],
    ["opencode", "opencode"],
    ["pi", "pi"],
  ])("deletes directly from %s after confirmation", async (toolId, appId) => {
    vi.mocked(providersApi.getAll).mockResolvedValue({ [route.id]: route });
    vi.mocked(providersApi.delete).mockResolvedValue(true);
    const onEditLine = vi.fn();
    render(<ToolView toolId={toolId} native onEditLine={onEditLine} />);
    const button = await screen.findByRole("button", {
      name: "删除Removable route",
    });
    expect(button).toHaveClass("tool-provider-delete");
    fireEvent.click(button);
    expect(providersApi.delete).not.toHaveBeenCalled();
    expect(onEditLine).not.toHaveBeenCalled();
    vi.mocked(providersApi.getAll).mockResolvedValue({});
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() =>
      expect(providersApi.delete).toHaveBeenCalledWith(route.id, appId),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "删除Removable route" }),
      ).not.toBeInTheDocument(),
    );
  });
  it("keeps current switch routes protected and built-in entries undeletable", async () => {
    vi.mocked(providersApi.getAll).mockResolvedValue({ [route.id]: route });
    vi.mocked(providersApi.getCurrent).mockResolvedValue(route.id);
    render(<ToolView toolId="claude-code" native />);
    expect(
      await screen.findByRole("button", { name: "删除Removable route" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "删除Claude Official" }),
    ).not.toBeInTheDocument();
  });
  it("cancel leaves the route unchanged", async () => {
    vi.mocked(providersApi.getAll).mockResolvedValue({ [route.id]: route });
    render(<ToolView toolId="opencode" native />);
    fireEvent.click(
      await screen.findByRole("button", { name: "删除Removable route" }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: /取消|Cancel/,
      }),
    );
    expect(providersApi.delete).not.toHaveBeenCalled();
  });
  it("retains the row and confirmation on delete failure", async () => {
    vi.mocked(providersApi.getAll).mockResolvedValue({ [route.id]: route });
    vi.mocked(providersApi.delete).mockResolvedValue(false);
    render(<ToolView toolId="opencode" native />);
    fireEvent.click(
      await screen.findByRole("button", { name: "删除Removable route" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "删除线路失败",
        expect.anything(),
      ),
    );
    expect(screen.getByText("Removable route")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
