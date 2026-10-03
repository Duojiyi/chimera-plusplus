import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { createTestQueryClient } from "../utils/testQueryClient";

vi.mock("@/views/NewSettingsView", () => ({
  NewSettingsView: () => <div>Connected settings</div>,
}));
vi.mock("@/components/sessions/SessionManagerPage", () => ({
  SessionManagerPage: ({ appId }: { appId: string }) => (
    <div>Connected sessions: {appId}</div>
  ),
}));
import App from "@/App";

function renderApp() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <App />
    </QueryClientProvider>,
  );
}

describe("v2.8 shell keeps existing backend-connected routes", () => {
  it("does not invent a current line or an installed Codex in browser preview", async () => {
    renderApp();
    expect(
      await screen.findByRole("button", { name: "开始配置" }),
    ).toBeVisible();
    expect(screen.getByText("浏览器预览 · 未连接本机")).toBeVisible();
    expect(screen.queryByText("未命名线路")).not.toBeInTheDocument();
    expect(screen.queryByText("Codex 已就绪")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "启动 Codex" }),
    ).not.toBeInTheDocument();
  });
  it("opens the real runtime controller instead of the timed simulation", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Codex 管理" }));
    expect(
      await screen.findByRole("heading", {
        name: "Codex 管理",
        level: 1,
      }),
    ).toBeVisible();
    expect(
      screen.queryByText("检测到 0.61.0 · 运行中 · 路径已同步"),
    ).not.toBeInTheDocument();
  });

  it("mounts the real line editor inside its production styling container", async () => {
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "开始配置" }));
    const editor = await screen.findByRole("region", { name: "新建线路" });
    expect(editor.parentElement).toHaveClass("provider-editor-page");
    expect(editor.closest("main")).toHaveClass("is-editing-provider");
    expect(
      document.querySelector('[data-pencil-name="侧栏"]'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "新建线路" })).toHaveFocus();
  });

  it("keeps one top-left controls group when opening the editor on macOS", async () => {
    const platform = vi
      .spyOn(window.navigator, "platform", "get")
      .mockReturnValue("MacIntel");
    try {
      renderApp();
      expect(document.querySelectorAll(".window-controls-mac")).toHaveLength(1);
      fireEvent.click(await screen.findByRole("button", { name: "开始配置" }));
      await screen.findByRole("region", { name: "新建线路" });
      expect(document.querySelectorAll(".window-controls-mac")).toHaveLength(1);
      expect(
        document.querySelector("header .window-controls-mac"),
      ).toBeInTheDocument();
    } finally {
      platform.mockRestore();
    }
  });

  it("keeps bottom navigation outside the scrollable tool list", async () => {
    renderApp();
    const tools = screen.getByRole("navigation", { name: "工具与功能" });
    expect(tools).toHaveClass("chimera-navigation");
    expect(tools).toContainElement(
      screen.getByRole("button", { name: "官方账号" }),
    );
    expect(tools).not.toContainElement(
      screen.getByRole("button", { name: "会话" }),
    );
    expect(tools).not.toContainElement(
      screen.getByRole("button", { name: "设置" }),
    );
  });

  it("opens the persisted settings implementation", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(await screen.findByText("Connected settings")).toBeVisible();
  });

  it("opens the backend-connected session manager", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "会话" }));
    expect(await screen.findByText("Connected sessions: all")).toBeVisible();
  });
});

it("distinguishes the browser appearance preview from a disabled product capability", async () => {
  renderApp();
  fireEvent.click(screen.getByRole("button", { name: "外观" }));
  expect(
    await screen.findByText(
      "浏览器预览不读取皮肤目录，请在桌面应用中查看真实皮肤。",
    ),
  ).toBeVisible();
});
