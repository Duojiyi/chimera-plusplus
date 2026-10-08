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
  const toggle = await screen.findByRole(
    "switch",
    { name: "Claude Desktop" },
    { timeout: 10000 },
  );
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
        omp: false,
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
  expect(
    screen.getByText("Pi", { selector: ".tool-visibility-name" }),
  ).toBeVisible();
  expect(screen.queryByRole("switch")).toBeNull();
  expect(settingsApi.get).not.toHaveBeenCalled();
});

it("defaults OMP to hidden for legacy settings without changing Pi", async () => {
  vi.mocked(settingsApi.get).mockResolvedValue({
    language: "zh",
    visibleApps: { codex: true, pi: true },
  } as never);
  const client = mount();
  const omp = await screen.findByRole("switch", { name: "oh-my-pi" });
  expect(omp).not.toBeChecked();
  expect(screen.getByRole("switch", { name: "Pi" })).toBeChecked();
  expect(
    within(omp.closest("li")!).getByText(/独立管理运行环境/),
  ).toBeVisible();
  fireEvent.click(omp);
  await waitFor(() => expect(omp).toBeChecked());
  expect(settingsApi.save).toHaveBeenCalledWith(
    expect.objectContaining({
      language: "zh",
      visibleApps: expect.objectContaining({
        codex: true,
        pi: true,
        omp: true,
      }),
    }),
  );
  expect(client.getQueryData(["settings"])).toMatchObject({
    visibleApps: { pi: true, omp: true },
  });
});

it("serializes OMP and Pi changes without losing either preference", async () => {
  let current = {
    language: "zh",
    visibleApps: { codex: true, pi: false, omp: true },
  };
  vi.mocked(settingsApi.get).mockImplementation(async () => current as never);
  vi.mocked(settingsApi.save).mockImplementation(async (next) => {
    current = next as typeof current;
    return true;
  });
  const client = mount();
  const omp = await screen.findByRole("switch", { name: "oh-my-pi" });
  const pi = screen.getByRole("switch", { name: "Pi" });
  expect(omp).toBeChecked();
  expect(pi).not.toBeChecked();
  fireEvent.click(omp);
  fireEvent.click(pi);
  await waitFor(() => expect(settingsApi.save).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(pi).toBeChecked());
  expect(omp).not.toBeChecked();
  expect(client.getQueryData(["settings"])).toMatchObject({
    language: "zh",
    visibleApps: { codex: true, pi: true, omp: false },
  });
});

it("keeps OMP hidden and the settings cache unchanged when saving fails", async () => {
  vi.mocked(settingsApi.save).mockResolvedValue(false);
  const client = mount();
  const omp = await screen.findByRole("switch", { name: "oh-my-pi" });
  const before = client.getQueryData(["settings"]);
  fireEvent.click(omp);
  expect(await screen.findByRole("alert")).toHaveTextContent("oh-my-pi");
  expect(omp).not.toBeChecked();
  expect(client.getQueryData(["settings"])).toEqual(before);
});
