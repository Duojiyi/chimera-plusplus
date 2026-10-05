import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ToolViewDesktop from "@/views/ToolViewDesktop";
import { ClaudeDesktopRouteToggle } from "@/components/proxy/ClaudeDesktopRouteToggle";
import { providersApi, type ClaudeDesktopStatus } from "@/lib/api/providers";
import { settingsApi } from "@/lib/api/settings";
import { toast } from "sonner";

const proxy = vi.hoisted(() => ({
  isRunning: false,
  isLoading: false,
  status: { address: "127.0.0.1", port: 15721 },
  takeoverStatus: {
    claude: false,
    codex: false,
    gemini: false,
    grokbuild: false,
  },
  startProxyServer: vi.fn(),
  stopProxyServer: vi.fn(),
  isStarting: false,
  isStoppingServer: false,
}));
vi.mock("@/hooks/useProxyStatus", () => ({ useProxyStatus: () => proxy }));
vi.mock("@/lib/api/providers", () => ({
  providersApi: {
    getClaudeDesktopStatus: vi.fn(),
    importClaudeDesktopFromClaude: vi.fn(),
    ensureClaudeDesktopOfficialProvider: vi.fn(),
  },
}));
vi.mock("@/lib/api/settings", () => ({
  settingsApi: { openExternal: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { warning: vi.fn() } }));

const emptyStatus: ClaudeDesktopStatus = {
  supported: true,
  configured: false,
  installationPath: null,
  proxyRunning: false,
  staleRawModels: false,
  missingRouteMappings: false,
  gatewayTokenConfigured: false,
};
const onChanged = vi.fn();
const onSupported = vi.fn();
const props = { native: true, refreshVersion: 0, onChanged, onSupported };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(providersApi.getClaudeDesktopStatus).mockResolvedValue(emptyStatus);
  vi.mocked(providersApi.importClaudeDesktopFromClaude).mockResolvedValue(2);
  vi.mocked(providersApi.ensureClaudeDesktopOfficialProvider).mockResolvedValue(
    true,
  );
  vi.mocked(settingsApi.openExternal).mockResolvedValue(undefined);
  onChanged.mockResolvedValue(undefined);
  proxy.isRunning = false;
  proxy.isLoading = false;
  proxy.isStarting = false;
  proxy.isStoppingServer = false;
  proxy.takeoverStatus.codex = false;
});

describe("Claude Desktop setup panel", () => {
  it("keeps config separate from installation and hides technical paths by default", async () => {
    vi.mocked(providersApi.getClaudeDesktopStatus).mockResolvedValue({
      ...emptyStatus,
      configured: true,
      mode: "direct",
      profilePath: "C:/Users/test/Claude/profile.json",
    });
    render(<ToolViewDesktop {...props} />);
    expect(await screen.findByText("已配置第三方")).toBeVisible();
    expect(screen.getByText("未检测到")).toBeVisible();
    expect(screen.getByRole("button", { name: "快速安装" })).toBeEnabled();
    expect(
      screen.getByRole("switch", { name: "Claude Desktop 本地路由" }),
    ).not.toBeChecked();
    expect(screen.getByText("直连模式 · 当前线路无需开启")).toBeVisible();
    const details = screen.getByText("诊断信息与使用说明").closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(details).toHaveTextContent("C:/Users/test/Claude/profile.json");
    expect(
      screen.getByText(/官方入口只是配置选项，不代表账号已登录/),
    ).toBeVisible();
    expect(providersApi.importClaudeDesktopFromClaude).not.toHaveBeenCalled();
    expect(
      providersApi.ensureClaudeDesktopOfficialProvider,
    ).not.toHaveBeenCalled();
    expect(settingsApi.openExternal).not.toHaveBeenCalled();
  });

  it.each([
    [
      "Windows x64",
      "https://claude.ai/api/desktop/win32/x64/setup/latest/redirect",
    ],
    [
      "Windows ARM64",
      "https://claude.ai/api/desktop/win32/arm64/setup/latest/redirect",
    ],
    [
      "macOS",
      "https://claude.ai/api/desktop/darwin/universal/dmg/latest/redirect",
    ],
  ])(
    "opens only the selected official %s installer without claiming installation success",
    async (name, url) => {
      render(<ToolViewDesktop {...props} />);
      await screen.findByText("未检测到");
      fireEvent.click(screen.getByRole("button", { name: "快速安装" }));
      const dialog = screen.getByRole("dialog", {
        name: "快速安装 Claude Desktop",
      });
      expect(dialog).toHaveTextContent("不会自动安装或启动应用");
      const link = within(dialog).getByRole("link", {
        name: `下载 ${name} 官方安装包`,
      });
      expect(link).toHaveAttribute("href", url);
      fireEvent.click(link);
      await waitFor(() =>
        expect(settingsApi.openExternal).toHaveBeenCalledWith(url),
      );
      expect(await within(dialog).findByRole("status")).toHaveTextContent(
        "手动运行",
      );
      expect(providersApi.getClaudeDesktopStatus).toHaveBeenCalledTimes(1);
      expect(screen.getByText("未检测到")).toBeInTheDocument();
      expect(onChanged).not.toHaveBeenCalled();

      vi.mocked(providersApi.getClaudeDesktopStatus).mockResolvedValue({
        ...emptyStatus,
        installationPath: "C:/Program Files/Claude/Claude.exe",
      });
      fireEvent.click(
        within(dialog).getByRole("button", { name: "返回并重新检测" }),
      );
      expect(await screen.findByText("已检测到")).toBeVisible();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "获取官方安装包" }),
      ).toBeEnabled();
    },
  );

  it("shows opener failures inside the install dialog and allows retry", async () => {
    vi.mocked(settingsApi.openExternal).mockRejectedValueOnce(
      new Error("browser unavailable"),
    );
    render(<ToolViewDesktop {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "快速安装" }));
    const dialog = screen.getByRole("dialog");
    const link = within(dialog).getByRole("link", { name: "官方下载页" });
    fireEvent.click(link);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "browser unavailable",
    );
    fireEvent.click(link);
    expect(await within(dialog).findByRole("status")).toHaveTextContent(
      "已在浏览器打开官方链接",
    );
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(settingsApi.openExternal).toHaveBeenLastCalledWith(
      "https://claude.com/download",
    );
  });

  it("does not open a second link while the native opener is pending", async () => {
    let finish!: () => void;
    vi.mocked(settingsApi.openExternal).mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    render(<ToolViewDesktop {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "快速安装" }));
    const link = screen.getByRole("link", {
      name: "下载 Windows x64 官方安装包",
    });
    fireEvent.click(link);
    fireEvent.click(link);
    expect(settingsApi.openExternal).toHaveBeenCalledTimes(1);
    expect(link).toHaveAttribute("aria-disabled", "true");
    await act(async () => finish());
    expect(link).not.toHaveAttribute("aria-disabled");
  });

  it("offers normal official links in preview without touching native services", () => {
    render(<ToolViewDesktop {...props} native={false} />);
    expect(screen.getByText("预览模式")).toBeVisible();
    expect(screen.getByRole("button", { name: "重新检测" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "从 Claude Code 导入" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "快速安装" }));
    expect(
      screen.getByRole("link", { name: "下载 macOS 官方安装包" }),
    ).toHaveAttribute("target", "_blank");
    expect(
      screen.getByRole("link", { name: "下载 macOS 官方安装包" }),
    ).toHaveAttribute("rel", "noopener noreferrer");
    expect(providersApi.getClaudeDesktopStatus).not.toHaveBeenCalled();
    expect(settingsApi.openExternal).not.toHaveBeenCalled();
  });

  it("disables configuration while checking and on unsupported platforms", async () => {
    let finish!: (value: ClaudeDesktopStatus) => void;
    vi.mocked(providersApi.getClaudeDesktopStatus).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<ToolViewDesktop {...props} />);
    expect(screen.getByRole("button", { name: "正在检测…" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "从 Claude Code 导入" }),
    ).toBeDisabled();
    await act(async () => finish({ ...emptyStatus, supported: false }));
    expect(screen.getByText("平台不支持")).toBeVisible();
    expect(screen.getByRole("button", { name: "添加官方入口" })).toBeDisabled();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(onSupported).toHaveBeenLastCalledWith(false);
  });

  it("clears stale installed status on a read failure and recovers on retry", async () => {
    vi.mocked(providersApi.getClaudeDesktopStatus)
      .mockResolvedValueOnce({
        ...emptyStatus,
        installationPath: "C:/Claude.exe",
      })
      .mockRejectedValueOnce(new Error("offline"));
    render(<ToolViewDesktop {...props} />);
    await screen.findByText("已检测到");
    fireEvent.click(screen.getByRole("button", { name: "重新检测" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法读取 Desktop 状态：offline",
    );
    expect(screen.queryByText("已检测到")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加官方入口" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重新检测" }));
    expect(await screen.findByText("未检测到")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores older status responses after a refresh", async () => {
    let finish!: (value: ClaudeDesktopStatus) => void;
    vi.mocked(providersApi.getClaudeDesktopStatus).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = render(<ToolViewDesktop {...props} />);
    view.rerender(<ToolViewDesktop {...props} refreshVersion={1} />);
    await screen.findByText("未检测到");
    await act(async () =>
      finish({
        ...emptyStatus,
        installationPath: "C:/stale.exe",
        supported: false,
      }),
    );
    expect(screen.getByText("未检测到")).toBeVisible();
    expect(onSupported).toHaveBeenLastCalledWith(true);
  });

  it("imports saved routes once, reports the count, and never activates them", async () => {
    let finish!: (count: number) => void;
    vi.mocked(providersApi.importClaudeDesktopFromClaude).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<ToolViewDesktop {...props} />);
    await screen.findByText("未检测到");
    const button = screen.getByRole("button", { name: "从 Claude Code 导入" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(providersApi.importClaudeDesktopFromClaude).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "正在导入…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "添加官方入口" })).toBeDisabled();
    await act(async () => finish(2));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "已导入 2 条兼容线路，未切换当前配置",
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("explains empty imports and existing official entries without claiming login", async () => {
    vi.mocked(providersApi.importClaudeDesktopFromClaude).mockResolvedValue(0);
    vi.mocked(
      providersApi.ensureClaudeDesktopOfficialProvider,
    ).mockResolvedValue(false);
    render(<ToolViewDesktop {...props} />);
    await screen.findByText("未检测到");
    fireEvent.click(
      screen.getByRole("button", { name: "从 Claude Code 导入" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "请先在 Claude Code 页面导入本机配置",
    );
    fireEvent.click(screen.getByRole("button", { name: "添加官方入口" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "官方入口已存在，未切换线路",
      ),
    );
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("reports import failures and does not refresh the route list", async () => {
    vi.mocked(providersApi.importClaudeDesktopFromClaude).mockRejectedValue(
      new Error("import failed"),
    );
    render(<ToolViewDesktop {...props} />);
    await screen.findByText("未检测到");
    fireEvent.click(
      screen.getByRole("button", { name: "从 Claude Code 导入" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "线路操作失败：import failed",
    );
    expect(onChanged).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "从 Claude Code 导入" }),
    ).toBeEnabled();
  });

  it("does not refresh another page when an import finishes after unmount", async () => {
    let finish!: (count: number) => void;
    vi.mocked(providersApi.importClaudeDesktopFromClaude).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = render(<ToolViewDesktop {...props} />);
    await screen.findByText("未检测到");
    fireEvent.click(
      screen.getByRole("button", { name: "从 Claude Code 导入" }),
    );
    view.unmount();
    await act(async () => finish(2));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("keeps actionable model warnings visible outside collapsed diagnostics", async () => {
    vi.mocked(providersApi.getClaudeDesktopStatus).mockResolvedValue({
      ...emptyStatus,
      staleRawModels: true,
      missingRouteMappings: true,
    });
    render(<ToolViewDesktop {...props} />);
    await screen.findByText("未检测到");
    expect(screen.getByText("模型配置已过期，请重新应用线路。")).toBeVisible();
    expect(
      screen.getByText("缺少模型路由映射，请检查线路配置。"),
    ).toBeVisible();
  });
});

describe("accessible Desktop routing switch", () => {
  it("labels the control and starts routing only on an explicit toggle", async () => {
    render(<ClaudeDesktopRouteToggle />);
    const toggle = screen.getByRole("switch", {
      name: "Claude Desktop 本地路由",
    });
    expect(screen.getByText("未开启")).toBeVisible();
    expect(proxy.startProxyServer).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(proxy.startProxyServer).toHaveBeenCalledTimes(1),
    );
  });
  it("does not stop routing while another tool uses takeover", async () => {
    proxy.isRunning = true;
    proxy.takeoverStatus.codex = true;
    render(<ClaudeDesktopRouteToggle />);
    expect(screen.getByText("已开启")).toBeVisible();
    fireEvent.click(
      screen.getByRole("switch", { name: "Claude Desktop 本地路由" }),
    );
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(proxy.stopProxyServer).not.toHaveBeenCalled();
  });
  it("disables an unknown loading state", () => {
    proxy.isLoading = true;
    render(<ClaudeDesktopRouteToggle />);
    expect(
      screen.getByRole("switch", { name: "Claude Desktop 本地路由" }),
    ).toBeDisabled();
    expect(screen.getByText("读取中…")).toBeVisible();
  });
});
