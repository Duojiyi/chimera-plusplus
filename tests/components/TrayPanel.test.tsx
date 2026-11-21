import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DailyStats, UsageSummary } from "@/types/usage";
import { TrayPanel } from "@/views/TrayPanel";
import * as usageMetrics from "@/utils/usageMetrics";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const commands = vi.mocked(invoke);
const events = vi.mocked(listen);
const listeners = new Map<string, (payload: unknown) => void>();

function snapshot(currentId: string, hasProjects = false) {
  return {
    language: "zh",
    hasProjects,
    lightweight: false,
    tools: [
      {
        id: "codex",
        name: "Codex",
        currentId,
        autoFailover: false,
        currentUsageSummary: null as string | null,
        lines: [
          { id: "first", name: "当前线路" },
          { id: "next", name: "备用线路" },
        ].map((line) => ({
          ...line,
          category: null,
          iconColor: null,
          badgeText: null,
          blockedByTakeover: false,
        })),
      },
    ],
  };
}

const totals: UsageSummary = {
  totalRequests: 4,
  totalCost: "0.12",
  totalInputTokens: 600,
  totalOutputTokens: 400,
  totalCacheCreationTokens: 0,
  totalCacheReadTokens: 0,
  realTotalTokens: 1000,
  successRate: 100,
  cacheHitRate: 0,
};

const interval: DailyStats = {
  date: "2026-11-21T12:00:00",
  requestCount: 4,
  totalCost: "0.12",
  totalTokens: 1000,
  totalInputTokens: 600,
  totalOutputTokens: 400,
  totalCacheCreationTokens: 0,
  totalCacheReadTokens: 0,
};

describe("TrayPanel", () => {
  beforeEach(() => {
    commands.mockReset();
    listeners.clear();
    events.mockImplementation(async (event, handler) => {
      listeners.set(event, (payload) => handler({ event, payload, id: 1 }));
      return () => listeners.delete(event);
    });
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.documentElement.classList.remove("light", "dark");
  });

  it("recovers a failed line read and switches only to an inactive line", async () => {
    let selected = "first";
    commands.mockImplementation(async (command, args) => {
      if (command === "get_tray_panel") return snapshot(selected);
      if (command === "switch_tray_line") {
        selected = (args as { id: string }).id;
        return undefined;
      }
      throw new Error(`Unexpected command ${command}`);
    });
    commands.mockRejectedValueOnce(
      new Error("database temporarily unavailable"),
    );
    const user = userEvent.setup();
    render(<TrayPanel />);

    expect(await screen.findByText(/无法读取线路/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "重试" }));
    const spare = await screen.findByRole("button", { name: /备用线路/ });
    expect(screen.getByRole("button", { name: /当前线路/ })).toBeDisabled();
    await user.click(spare);

    expect(commands).toHaveBeenCalledWith("switch_tray_line", {
      tool: "codex",
      id: "next",
    });
    expect(await screen.findByText(/已切换/)).toBeVisible();
    await waitFor(() => expect(spare).toHaveAttribute("aria-current", "true"));
  });

  it("refreshes routes when a tray project finishes applying after the menu closes", async () => {
    let current = "first";
    commands.mockImplementation(async (command) => {
      if (command === "get_tray_panel") return snapshot(current, true);
      if (command === "tray_panel_action") return undefined;
      throw new Error(`Unexpected command ${command}`);
    });
    const user = userEvent.setup();
    render(<TrayPanel />);

    const projects = await screen.findByRole("button", { name: "项目" });
    const next = screen.getByRole("button", { name: "备用线路" });
    await user.click(projects);
    expect(commands).toHaveBeenCalledWith("tray_panel_action", {
      action: "projects",
    });
    await waitFor(() => expect(projects).toBeEnabled());
    expect(next).not.toHaveAttribute("aria-current");
    expect(screen.queryByText("切换项目失败。")).not.toBeInTheDocument();

    expect(events).toHaveBeenCalledWith(
      "profile-applied",
      expect.any(Function),
    );
    current = "next";
    act(() => listeners.get("profile-applied")!({ profileId: "p1" }));
    await waitFor(() => expect(next).toHaveAttribute("aria-current", "true"));
  });

  it("keeps a project failure visible when the native menu returns focus", async () => {
    commands.mockImplementation(async (command) => {
      if (command === "get_tray_panel") return snapshot("first", true);
      if (command === "tray_panel_action") return undefined;
      throw new Error(`Unexpected command ${command}`);
    });
    render(<TrayPanel />);
    await userEvent.click(await screen.findByRole("button", { name: "项目" }));

    expect(events).toHaveBeenCalledWith(
      "tray-project-result",
      expect.any(Function),
      {
        target: "tray-panel",
      },
    );
    act(() => {
      listeners.get("tray-project-result")!({
        operation: 1,
        scope: "codex",
        profileId: "p1",
        result: { status: "error", message: "项目缺少关联线路" },
      });
      window.dispatchEvent(new Event("focus"));
    });
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("切换项目失败。");
    expect(status).toHaveTextContent("项目缺少关联线路");
    expect(screen.getByRole("button", { name: /当前线路/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it.each([
    ["partial", "项目未设为当前，部分配置未能恢复。", "保存的线路已删除"],
    ["warning", "项目已设为当前，请查看提示。", "此分组尚未保存配置"],
  ])(
    "shows the %s project result and reloads routes",
    async (status, title, detail) => {
      let current = "first";
      commands.mockImplementation(async (command) => {
        if (command === "get_tray_panel") return snapshot(current, true);
        if (command === "tray_panel_action") return undefined;
        throw new Error(`Unexpected command ${command}`);
      });
      render(<TrayPanel />);
      await userEvent.click(
        await screen.findByRole("button", { name: "项目" }),
      );

      current = status === "partial" ? "next" : "first";
      act(() =>
        listeners.get("tray-project-result")!({
          operation: 1,
          scope: "codex",
          profileId: "p1",
          result: { status, warnings: [detail] },
        }),
      );
      const feedback = await screen.findByRole("status");
      expect(feedback).toHaveTextContent(title);
      expect(feedback).toHaveTextContent(detail);
      expect(feedback).not.toHaveClass("is-error");
      await waitFor(() =>
        expect(
          screen.getByRole("button", {
            name: current === "next" ? /备用线路/ : /当前线路/,
          }),
        ).toHaveAttribute("aria-current", "true"),
      );
    },
  );

  it("clears an old project notice when a newer project is applied", async () => {
    commands.mockResolvedValue(snapshot("first", true));
    render(<TrayPanel />);
    await screen.findByRole("button", { name: "项目" });
    const emit = listeners.get("tray-project-result")!;
    const older = {
      operation: 1,
      scope: "codex",
      profileId: "p1",
      result: { status: "partial", warnings: ["旧项目警告"] },
    };
    act(() => emit(older));
    expect(screen.getByRole("status")).toHaveTextContent("旧项目警告");
    act(() => {
      emit({
        operation: 2,
        scope: "codex",
        profileId: "p2",
        result: { status: "cleared" },
      });
      emit(older);
    });
    expect(screen.queryByText("旧项目警告")).not.toBeInTheDocument();
  });

  it("retains project notices per scope when results arrive out of order", async () => {
    commands.mockResolvedValue(snapshot("first", true));
    render(<TrayPanel />);
    await screen.findByRole("button", { name: "项目" });
    const emit = listeners.get("tray-project-result")!;
    act(() => {
      emit({ operation: 2, scope: "claude", result: { status: "cleared" } });
      emit({
        operation: 1,
        scope: "codex",
        result: { status: "partial", warnings: ["Codex 线路未恢复"] },
      });
    });
    expect(screen.getByRole("status")).toHaveTextContent("Codex 线路未恢复");

    act(() =>
      emit({
        operation: 3,
        scope: "claude",
        result: { status: "error", message: "Claude 项目缺少配置" },
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Claude 项目缺少配置");
    expect(screen.getByRole("status")).toHaveTextContent("Codex 线路未恢复");

    act(() =>
      emit({ operation: 4, scope: "codex", result: { status: "cleared" } }),
    );
    expect(screen.queryByText("Codex 线路未恢复")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Claude 项目缺少配置");
  });

  it("updates the current route and proxy flags while the panel is focused", async () => {
    let current = "first";
    let automatic = true;
    commands.mockImplementation(async (command) => {
      if (command !== "get_tray_panel")
        throw new Error(`Unexpected command ${command}`);
      const state = snapshot(current);
      state.tools[0].autoFailover = automatic;
      return state;
    });
    const { unmount } = render(<TrayPanel />);
    const original = await screen.findByRole("button", { name: /当前线路/ });
    const backup = screen.getByRole("button", { name: /备用线路/ });
    expect(original).toHaveAttribute("aria-current", "true");
    expect(backup).not.toHaveAttribute("aria-current");

    current = "next";
    act(() =>
      listeners.get("provider-switched")!({
        appType: "codex",
        providerId: "next",
      }),
    );
    await waitFor(() => expect(backup).toHaveAttribute("aria-current", "true"));
    expect(backup).toHaveTextContent("固定当前线路");
    expect(original).not.toHaveAttribute("aria-current");
    expect(original).not.toHaveTextContent("固定当前线路");

    automatic = false;
    act(() => listeners.get("proxy-flags-changed")!({ appType: "codex" }));
    await waitFor(() => expect(backup).not.toHaveTextContent("固定当前线路"));
    expect(backup).toBeDisabled();

    unmount();
    await waitFor(() => expect(listeners.size).toBe(0));
  });

  it("shows and refreshes the current route's cached balance without querying usage", async () => {
    let summary: string | null = null;
    commands.mockImplementation(async (command) => {
      if (command !== "get_tray_panel")
        throw new Error(`Unexpected command ${command}`);
      const state = snapshot("first");
      state.tools[0].currentUsageSummary = summary;
      return state;
    });
    render(<TrayPanel />);
    const current = await screen.findByRole("button", { name: /当前线路/ });
    expect(current).toHaveAttribute("aria-current", "true");
    expect(screen.queryByText("$24.50")).not.toBeInTheDocument();

    summary = "$24.50";
    act(() =>
      listeners.get("usage-cache-updated")!({
        appType: "codex",
        providerId: "first",
      }),
    );
    expect(await screen.findByText(summary)).toBeVisible();
    expect(commands.mock.calls.map(([command]) => command)).toEqual([
      "get_tray_panel",
      "get_tray_panel",
    ]);
  });

  it("explains blocked routes and lets users pin the current automatic route", async () => {
    let automatic = true;
    commands.mockImplementation(async (command) => {
      if (command === "get_tray_panel") {
        const state = snapshot("first");
        state.tools[0].autoFailover = automatic;
        state.tools[0].lines[1].blockedByTakeover = true;
        return state;
      }
      if (command === "switch_tray_line") {
        automatic = false;
        return undefined;
      }
      throw new Error(`Unexpected command ${command}`);
    });
    const user = userEvent.setup();
    render(<TrayPanel />);

    const blocked = await screen.findByRole("button", { name: /备用线路/ });
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveTextContent("本地代理接管时无法选择此线路");
    await user.click(blocked);
    expect(commands).not.toHaveBeenCalledWith(
      "switch_tray_line",
      expect.anything(),
    );

    const current = screen.getByRole("button", { name: /固定当前线路/ });
    expect(current).toBeEnabled();
    await user.click(current);
    expect(commands).toHaveBeenCalledWith("switch_tray_line", {
      tool: "codex",
      id: "first",
    });
    expect(await screen.findByText("已固定当前线路。")).toBeVisible();
    await waitFor(() => expect(current).toBeDisabled());
    expect(screen.queryByText("自动故障转移")).not.toBeInTheDocument();
  });

  it.each([
    ["en", "Routes", "Usage", "Today"],
    ["zh-TW", "線路", "用量", "今日"],
    ["ja", "接続先", "使用量", "今日"],
  ])(
    "uses tray language %s for both tabs",
    async (language, lines, usage, today) => {
      commands.mockImplementation(async (command) => {
        if (command === "get_tray_panel")
          return { ...snapshot("first"), language };
        if (command === "get_usage_summary") return totals;
        if (command === "get_usage_trends") return [interval];
        throw new Error(`Unexpected command ${command}`);
      });
      render(<TrayPanel />);

      expect(await screen.findByRole("tab", { name: lines })).toBeVisible();
      expect(screen.getByRole("main")).toHaveAttribute("lang", language);
      await userEvent.click(screen.getByRole("tab", { name: usage }));
      expect(screen.getByRole("button", { name: today })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    },
  );

  it("reads only Codex usage and requests dismissal on Escape", async () => {
    commands.mockImplementation(async (command) => {
      switch (command) {
        case "get_tray_panel":
          return snapshot("first");
        case "get_usage_summary":
          return totals;
        case "get_usage_trends":
          return [interval];
        case "tray_panel_action":
          return undefined;
        default:
          throw new Error(`Unexpected command ${command}`);
      }
    });
    const user = userEvent.setup();
    render(<TrayPanel />);

    await user.click(screen.getByRole("tab", { name: "用量" }));
    expect(await screen.findByText("$0.12")).toBeVisible();
    expect(screen.getByRole("img", { name: /峰值 1,000/ })).toBeVisible();
    for (const command of ["get_usage_summary", "get_usage_trends"]) {
      expect(commands).toHaveBeenCalledWith(
        command,
        expect.objectContaining({
          appType: "codex",
          startDate: expect.any(Number),
          endDate: expect.any(Number),
        }),
      );
    }
    await user.keyboard("{Escape}");
    expect(commands).toHaveBeenCalledWith("tray_panel_action", {
      action: "hide",
    });
  });

  it("labels a 25-hour today window with the backend's daily bucket", async () => {
    vi.spyOn(usageMetrics, "usageWindow").mockReturnValue({
      start: 100000,
      end: 188200,
    });
    commands.mockImplementation(async (command) => {
      if (command === "get_tray_panel") return snapshot("first");
      if (command === "get_usage_summary") return totals;
      if (command === "get_usage_trends")
        return [{ ...interval, date: "2026-11-01" }];
      throw new Error(`Unexpected command ${command}`);
    });
    render(<TrayPanel />);
    await userEvent.click(screen.getByRole("tab", { name: "用量" }));
    expect(await screen.findByTitle("11/01 · 1,000 词元")).toBeInTheDocument();
  });

  it("keeps the panel usable when the main window fails to open", async () => {
    commands.mockImplementation(async (command) => {
      if (command === "get_tray_panel") return snapshot("first");
      if (command === "tray_panel_action") throw new Error("创建主窗口失败");
      throw new Error(`Unexpected command ${command}`);
    });
    render(<TrayPanel />);
    const open = screen.getByRole("button", { name: "打开主界面" });
    await userEvent.click(open);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "创建主窗口失败",
    );
    expect(open).toBeEnabled();
  });
});
