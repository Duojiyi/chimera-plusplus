import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { ToolVisibilityView } from "@/views/ToolVisibilityView";
import { settingsApi } from "@/lib/api/settings";
vi.mock("@/lib/api/settings", () => ({
  settingsApi: { get: vi.fn(), save: vi.fn() },
}));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(settingsApi.get).mockResolvedValue({
    language: "zh",
    visibleApps: { codex: true, claude: true },
  } as never);
  vi.mocked(settingsApi.save).mockResolvedValue(true);
});
function mount(native = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ToolVisibilityView native={native} />
    </QueryClientProvider>,
  );
  return client;
}
it("persists explicit tool enablement, preserves preferences, and updates the navigation cache", async () => {
  const client = mount();
  const toggle = await screen.findByRole("switch", { name: "Claude Desktop" });
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeChecked());
  expect(settingsApi.save).toHaveBeenCalledWith(
    expect.objectContaining({
      language: "zh",
      visibleApps: expect.objectContaining({
        codex: true,
        claude: true,
        "claude-desktop": true,
        mcode: false,
      }),
    }),
  );
  expect(client.getQueryData(["settings"])).toMatchObject({
    visibleApps: { "claude-desktop": true },
  });
});
it("applies a change only after the save finishes and marks only that row as pending", async () => {
  let finish!: (saved: boolean) => void;
  vi.mocked(settingsApi.save).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  mount();
  const toggle = await screen.findByRole("switch", { name: "OpenCode" });
  fireEvent.click(toggle);
  const row = toggle.closest("li")!;
  await waitFor(() => expect(row).toHaveAttribute("aria-busy", "true"));
  expect(toggle).not.toBeChecked();
  expect(toggle).toHaveAttribute("aria-disabled", "true");
  expect(within(row).getByText("正在保存…")).toBeVisible();
  expect(screen.getByRole("switch", { name: "Pi" })).not.toHaveAttribute(
    "aria-disabled",
  );
  fireEvent.click(toggle);
  await act(async () => finish(true));
  await waitFor(() => expect(toggle).toBeChecked());
  expect(row).not.toHaveAttribute("aria-busy");
  expect(settingsApi.save).toHaveBeenCalledTimes(1);
});
it("does not optimistically enable a tool on save failure and names the tool", async () => {
  vi.mocked(settingsApi.save).mockRejectedValue(new Error("offline"));
  mount();
  const toggle = await screen.findByRole("switch", { name: "Grok Build" });
  fireEvent.click(toggle);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Grok Build");
  expect(alert).toHaveTextContent("offline");
  expect(toggle).not.toBeChecked();
});
it("keeps Codex as the always-on core entry and lists known limits", async () => {
  mount();
  await screen.findByRole("switch", { name: "Pi" });
  expect(screen.queryByRole("switch", { name: "Codex" })).toBeNull();
  const codex = screen.getByText("Codex").closest("li")!;
  expect(codex).toHaveTextContent("始终显示");
  expect(
    screen.getByRole("list", { name: "Claude Desktop 的已知限制" }),
  ).toHaveTextContent("仅检测标准安装路径");
  expect(
    screen.getByRole("list", { name: "OpenClaw 的已知限制" }),
  ).toHaveTextContent("暂不支持受管 MCP");
  for (const name of ["Pi", "MiniMax Code"])
    expect(
      screen.getByRole("list", { name: `${name} 的已知限制` }),
    ).toHaveTextContent("无安装管理");
  expect(screen.getByRole("note")).toHaveTextContent(
    "不会安装工具，也不会导入或激活任何线路",
  );
});
it("labels each switch with its tool so the name toggles it too", async () => {
  mount();
  const toggle = await screen.findByRole("switch", { name: "Hermes" });
  expect(toggle).toHaveAccessibleDescription(/可同时启用多条线路/);
  fireEvent.click(screen.getByText("Hermes"));
  await waitFor(() => expect(toggle).toBeChecked());
});
it("shows a retry when preferences cannot be read", async () => {
  vi.mocked(settingsApi.get).mockRejectedValueOnce(new Error("busy"));
  mount();
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("无法读取工具偏好");
  expect(screen.queryByRole("switch")).toBeNull();
  fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
  expect(
    await screen.findByRole("switch", { name: "Claude Code" }),
  ).toBeChecked();
});
it("does not read or write preferences in browser preview", async () => {
  mount(false);
  expect(
    await screen.findByText(/浏览器预览无法读取或保存本机工具偏好/),
  ).toBeVisible();
  expect(screen.getByText("MiniMax Code")).toBeVisible();
  expect(screen.queryByRole("switch")).toBeNull();
  expect(settingsApi.get).not.toHaveBeenCalled();
});
