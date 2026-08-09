import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "@/App";

describe("Chimera++ application shell", () => {
  it("exposes only the Codex product navigation", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "供应商" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "供应商" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更新" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "词元" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "外观" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
    expect(screen.queryByText("Gemini")).not.toBeInTheDocument();
    expect(screen.queryByText("Claude Code")).not.toBeInTheDocument();
    expect(screen.queryByText("OpenClaw")).not.toBeInTheDocument();
  });

  it("switches between the runtime, token, appearance, and settings surfaces", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "更新" }));
    expect(
      screen.getByRole("heading", {
        name: "本机 Codex 已准备就绪",
        level: 1,
      }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "词元" }));
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(
      await screen.findByRole("heading", { name: "词元消耗" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "外观" }));
    expect(
      await screen.findByRole("heading", { name: "皮肤市场" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(
      await screen.findByRole("heading", { name: "设置" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^数据与日志/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "恢复默认设置" }),
    ).toBeInTheDocument();
  }, 15_000);

  it("exposes direct line switching and the complete line management flow", async () => {
    render(<App />);

    expect(await screen.findByText("线路切换")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "默认线路，Chimera 中转站，当前线路",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "添加线路" }),
    ).toBeInTheDocument();

    const managerTrigger = screen.getByRole("button", { name: "管理线路" });
    fireEvent.click(managerTrigger);
    expect(
      screen.getByRole("dialog", { name: "管理线路" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "搜索线路" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "管理线路" }),
      ).not.toBeInTheDocument(),
    );
    expect(managerTrigger).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "添加线路" }));
    expect(
      screen.getByRole("heading", { name: "添加线路" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("线路名称")).toHaveValue("新线路");

    fireEvent.click(screen.getByText("高级选项"));
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
