import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolView } from "@/views/ToolView";
import { providersApi } from "@/lib/api/providers";
import { toast } from "sonner";
import type { Provider } from "@/types";
vi.mock("@/lib/api/providers", () => ({
  providersApi: {
    getAll: vi.fn(),
    getCurrent: vi.fn(),
    addAndActivate: vi.fn(),
    switch: vi.fn(),
    removeFromLiveConfig: vi.fn(),
    openTerminal: vi.fn(),
  },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(providersApi.getAll).mockResolvedValue({});
  vi.mocked(providersApi.getCurrent).mockResolvedValue("");
  vi.mocked(providersApi.addAndActivate).mockResolvedValue(true);
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
