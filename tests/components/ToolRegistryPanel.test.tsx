import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolRegistryPanel } from "@/components/settings/ToolRegistryPanel";
import { toolRegistryApi, type ToolInfo } from "@/lib/api/toolRegistry";
import registry from "@/shared/tool-registry.json";
import type { Settings } from "@/types";
vi.mock("@/components/settings/AboutSection", () => ({
  AboutSection: () => <section aria-label="工具安装管理" />,
}));
vi.mock("@/lib/api/toolRegistry", () => ({
  toolRegistryApi: { list: vi.fn() },
}));
const tools: ToolInfo[] = [
  {
    id: "codex",
    mode: "switch",
    liveFiles: ["~/.codex/config.toml"],
    tray: true,
    proxy: true,
    deeplink: "importConfirm",
  },
  {
    id: "pi",
    mode: "additive",
    liveFiles: ["~/.pi/agent/models.json"],
    tray: false,
    proxy: false,
    deeplink: "importOnly",
  },
];
beforeEach(() => {
  vi.resetAllMocks();
});
describe("tool registry settings", () => {
  it("shares the complete seven-tool metadata without installation or user data", () => {
    expect(registry.map((tool) => tool.id)).toEqual([
      "codex",
      "claude",
      "claude-desktop",
      "gemini",
      "grokbuild",
      "opencode",

      "pi",
    ]);
    expect(
      registry
        .filter((tool) => tool.deeplink === "importConfirm")
        .map((tool) => tool.id),
    ).toEqual(["codex"]);
    expect(
      registry
        .filter((tool) => tool.deeplink === "reject")
        .map((tool) => tool.id),
    ).toEqual([]);
    for (const tool of registry) {
      expect(Object.keys(tool).sort()).toEqual([
        "deeplink",
        "id",
        "liveFiles",
        "mode",
        "proxy",
        "tray",
      ]);
      expect(["switch", "additive"]).toContain(tool.mode);
      expect(tool.liveFiles.length).toBeGreaterThan(0);
    }
  });
  it("does not invoke native APIs or invent installations in a browser", () => {
    render(<ToolRegistryPanel settings={null} native={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("浏览器预览");
    expect(toolRegistryApi.list).not.toHaveBeenCalled();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getAllByText("偏好未读取")).toHaveLength(7);
  });
  it("uses backend rows and distinguishes saved visibility from installation", async () => {
    vi.mocked(toolRegistryApi.list).mockResolvedValue(tools);
    const { container } = render(
      <ToolRegistryPanel settings={{} as Settings} native />,
    );
    await screen.findByText("Codex");
    expect(
      await screen.findByRole("region", { name: "工具安装管理" }),
    ).toBeInTheDocument();
    expect(container.querySelectorAll(".settings-tool-row")).toHaveLength(2);
    expect(screen.getByText("切换型")).toBeInTheDocument();
    expect(screen.getByText("增量型")).toBeInTheDocument();
    expect(screen.getByText("已设为显示")).toBeInTheDocument();
    expect(screen.getByText("未设为显示")).toBeInTheDocument();
    expect(screen.getByText("~/.pi/agent/models.json")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });
  it("preserves saved hidden Codex and visible Pi preferences", async () => {
    vi.mocked(toolRegistryApi.list).mockResolvedValue(tools);
    const { container } = render(
      <ToolRegistryPanel
        settings={{ visibleApps: { codex: false, pi: true } } as Settings}
        native
      />,
    );
    await screen.findByText("Codex");
    expect(
      container.querySelectorAll(".settings-tool-row > summary")[0],
    ).toHaveTextContent("未设为显示");
    expect(
      container.querySelectorAll(".settings-tool-row > summary")[1],
    ).toHaveTextContent("已设为显示");
  });
  it("shows an error and permits retry without exposing backend error details", async () => {
    vi.mocked(toolRegistryApi.list).mockRejectedValueOnce(
      new Error("private path"),
    );
    vi.mocked(toolRegistryApi.list).mockResolvedValueOnce(tools);
    render(<ToolRegistryPanel settings={null} native />);
    await screen.findByRole("alert");
    expect(screen.queryByText(/private path/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("Codex");
    expect(toolRegistryApi.list).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("偏好未读取")).toHaveLength(2);
  });
  it("discards an old request after switching out of the native environment", async () => {
    let resolve!: (value: ToolInfo[]) => void;
    vi.mocked(toolRegistryApi.list).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = render(<ToolRegistryPanel settings={null} native />);
    expect(screen.getByRole("status")).toHaveTextContent("正在读取");
    view.rerender(<ToolRegistryPanel settings={null} native={false} />);
    await act(async () => resolve(tools));
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getAllByText("偏好未读取")).toHaveLength(7);
  });
  it("renders an empty registry explicitly", async () => {
    vi.mocked(toolRegistryApi.list).mockResolvedValue([]);
    render(<ToolRegistryPanel settings={null} native />);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("工具注册表为空"),
    );
  });
});
