import { ThemeProvider } from "@/components/theme-provider";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import App from "@/App";
import { createTestQueryClient } from "../utils/testQueryClient";

type RenderResult = ReturnType<typeof render>;
function renderApp(): RenderResult {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe("Chimera++ application shell", () => {
  it("exposes Codex routes and supported OpenClaw navigation", async () => {
    renderApp();

    expect(screen.getByRole("button", { name: "会话" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "线路" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Codex 管理" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "用量" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "外观" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
    const openClaw = await screen.findByRole("button", { name: "OpenClaw" });
    expect(openClaw).toBeEnabled();
    fireEvent.click(openClaw);
    expect(
      await screen.findByRole("heading", { name: "OpenClaw", level: 1 }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Claude Code" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "线路" }));
    expect(
      await screen.findByRole("button", { name: "开始配置" }),
    ).toBeVisible();
  });

  it("exposes backend-enabled navigation slots without fixture data", async () => {
    renderApp();
    const backendEnabledLabels = [
      "官方账号",
      "Claude Code",
      "Gemini CLI",
      "OpenCode",
      "Pi",
    ];
    for (const label of backendEnabledLabels) {
      const button = screen.getByRole("button", { name: label });
      expect(button).toBeEnabled();
      fireEvent.click(button);
      fireEvent.click(screen.getByRole("button", { name: "线路" }));
    }
    for (const label of ["提示词", "Skills 与 MCP", "配置体检"]) {
      const button = screen.getByRole("button", { name: label });
      expect(button).toBeEnabled();
      fireEvent.click(button);
      fireEvent.click(screen.getByRole("button", { name: "线路" }));
    }
    expect(
      await screen.findByRole("button", { name: "开始配置" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("table", { name: "线路切换" }),
    ).not.toBeInTheDocument();
    const sidebar = screen
      .getByRole("button", { name: "线路" })
      .closest("aside")!;
    expect(
      [...sidebar.querySelectorAll('[data-pencil-name^="能力 ·"]')].map(
        (item) => item.textContent?.trim(),
      ),
    ).toEqual([
      "线路",
      "官方账号",
      "提示词",
      "Skills 与 MCP",
      "用量",
      "Codex 管理",
      "外观",
      "配置体检",
    ]);
  });

  it("switches between the runtime, token, appearance, and settings surfaces", async () => {
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "Codex 管理" }));
    expect(
      screen.getByRole("heading", {
        name: "Codex 管理",
        level: 1,
      }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "用量" }));
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(
      await screen.findByRole("heading", { name: "用量" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "外观" }));
    expect(
      await screen.findByText("浏览器预览不读取皮肤目录"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(
      await screen.findByRole("heading", { name: "设置" }),
    ).toBeInTheDocument();
    // Settings opens at 工具; the preference rows are one section away.
    fireEvent.click(screen.getByRole("link", { name: "通用设置" }));
    expect(
      screen.getByRole("button", { name: /^数据与日志/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "恢复默认设置" }),
    ).toBeInTheDocument();
  }, 15_000);

  it("offers first-line setup without inventing a saved or current line", async () => {
    renderApp();
    const setup = await screen.findByRole("button", { name: "开始配置" });
    expect(
      screen.queryByRole("table", { name: "线路切换" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "管理线路" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("浏览器预览 · 未连接本机")).toBeVisible();
    fireEvent.click(setup);
    expect(
      await screen.findByRole("heading", { name: "新建线路" }),
    ).toBeVisible();
    expect(screen.getByLabelText(/线路名称/)).toHaveValue("默认线路");

    fireEvent.click(screen.getByText("高级配置"));
    expect(
      screen.getByRole("checkbox", { name: /目标模式/ }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /远程上下文压缩/ }),
    ).not.toBeChecked();
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: /应用通用配置/ }),
      ).toBeEnabled(),
    );
    expect(screen.getByRole("button", { name: "编辑通用配置" })).toBeEnabled();
  });
});
