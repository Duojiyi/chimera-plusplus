import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  const checkbox = screen.getByRole("checkbox", { name: "Claude Desktop" });
  await waitFor(() => expect(checkbox).toBeEnabled());
  expect(checkbox).not.toBeChecked();
  fireEvent.click(checkbox);
  await waitFor(() => expect(checkbox).toBeChecked());
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
it("does not optimistically enable a tool on save failure", async () => {
  vi.mocked(settingsApi.save).mockRejectedValue(new Error("offline"));
  mount();
  const checkbox = screen.getByRole("checkbox", { name: "Grok Build" });
  await waitFor(() => expect(checkbox).toBeEnabled());
  fireEvent.click(checkbox);
  expect(await screen.findByRole("alert")).toHaveTextContent("offline");
  expect(checkbox).not.toBeChecked();
});
it("does not read or write preferences in browser preview", () => {
  mount(false);
  expect(settingsApi.get).not.toHaveBeenCalled();
  expect(screen.getByRole("checkbox", { name: "MiniMax Code" })).toBeDisabled();
});
