import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolView } from "@/views/ToolView";
import { piApi } from "@/lib/api/pi";

vi.mock("@/lib/api/pi", () => ({ piApi: { read: vi.fn(), save: vi.fn() } }));

import { providersApi } from "@/lib/api/providers";

vi.mock("@/lib/api/providers", () => ({
  providersApi: {
    getAll: vi.fn(),
    getCurrent: vi.fn(),
    onSwitched: vi.fn().mockResolvedValue(() => {}),
  },
}));
vi.mock("@/components/settings/AboutSection", () => ({
  AboutSection: ({ tools }: { tools: string[] }) => (
    <section aria-label="环境检测">
      <p>检测工具：{tools.join(",")}</p>
      <button>刷新</button>
      <button>安装与升级</button>
    </section>
  ),
}));

beforeEach(() => {
  vi.mocked(providersApi.getAll).mockResolvedValue({
    saved: { id: "saved", name: "已保存线路", settingsConfig: {} },
  });
  vi.mocked(providersApi.getCurrent).mockResolvedValue("saved");
});

describe("ToolView information hierarchy", () => {
  it("puts routes before a closed native disclosure and preserves its contents on collapse", async () => {
    const { container } = render(<ToolView toolId="claude-code" native />);
    const route = await screen.findByText("已保存线路");
    const check = await screen.findByText("检测工具：claude");
    const disclosure = container.querySelector("details")!;
    const summary = disclosure.querySelector("summary")!;
    expect(disclosure.open).toBe(false);
    expect(check).not.toBeVisible();
    expect(
      route.compareDocumentPosition(disclosure) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "刷新线路" })).toBeVisible();
    fireEvent.click(summary);
    expect(disclosure.open).toBe(true);
    expect(check).toBeVisible();
    expect(screen.getByRole("button", { name: "刷新" })).toBeVisible();
    expect(screen.getByRole("button", { name: "安装与升级" })).toBeVisible();
    fireEvent.click(summary);
    expect(check).toBeInTheDocument();
    expect(check).not.toBeVisible();
    expect(route).toBeVisible();
  });

  it("exposes Pi lifecycle checks without enabling unsupported resources", async () => {
    render(<ToolView toolId="pi" native />);
    const check = await screen.findByText("检测工具：pi");
    expect(check).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "安装与更新" }));
    expect(check).toBeVisible();
    expect(screen.getByText(/统一 Skills 同步暂未接入/)).toBeVisible();
    expect(
      screen.queryByText(/安装检测与托管升级尚未接入/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /管理 Pi 的/ }),
    ).not.toBeInTheDocument();
  });
});

it("separates Pi routes, configuration, plugins and installation", async () => {
  render(<ToolView toolId="pi" native={false} />);
  await screen.findByText("已保存线路");
  expect(screen.getByRole("button", { name: "添加线路" })).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "读取全局配置" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "默认模型与 MCP" }));
  expect(screen.getByRole("button", { name: "读取全局配置" })).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "添加线路" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "插件市场" }));
  expect(screen.getByText("精选推荐 · 10")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "oh-my-pi" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "安装与更新" }));
  expect(screen.getByText("安装与环境检查")).toBeVisible();
  expect(screen.getByText("精选推荐 · 10")).not.toBeVisible();
});

it("retains unsaved Pi configuration when moving between sections", async () => {
  vi.mocked(piApi.read).mockImplementation(async (kind) => ({
    path: `/pi/${kind}.json`,
    revision: "1",
    value:
      kind === "settings" ? { defaultModel: "original" } : { mcpServers: {} },
  }));
  render(<ToolView toolId="pi" native />);
  fireEvent.click(screen.getByRole("button", { name: "默认模型与 MCP" }));
  fireEvent.click(screen.getByRole("button", { name: "读取全局配置" }));
  await screen.findByDisplayValue("original");
  fireEvent.change(screen.getByLabelText("模型 ID"), {
    target: { value: "unsaved-model" },
  });
  fireEvent.click(screen.getByRole("button", { name: "插件市场" }));
  fireEvent.click(screen.getByRole("button", { name: "默认模型与 MCP" }));
  expect(screen.getByLabelText("模型 ID")).toHaveValue("unsaved-model");
  expect(piApi.save).not.toHaveBeenCalled();
});
