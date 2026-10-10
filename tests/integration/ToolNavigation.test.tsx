import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, expect, it, vi } from "vitest";
import { createTestQueryClient } from "../utils/testQueryClient";
vi.mock("@/contexts/UpdateContext", () => ({ useUpdate: () => ({}) }));
vi.mock("@/views/ToolView", () => ({
  ToolView: ({
    toolId,
    refreshVersion,
  }: {
    toolId: string;
    refreshVersion: number;
  }) => (
    <div>
      tool:{toolId}:refresh:{refreshVersion}
    </div>
  ),
}));
import ChimeraApp from "@/ChimeraApp";
// Keep Vite's cold module transform outside RTL's one-second DOM wait.
beforeAll(async () => {
  await import("@/views/OmpView");
});
it.each([
  ["Claude Desktop", "claude-desktop"],
  ["Grok Build", "grokbuild"],

  ["Claude Code", "claude-code"],
  ["Gemini CLI", "gemini-cli"],
  ["OpenCode", "opencode"],
  ["Pi", "pi"],
])(
  "navigates to %s and passes refreshVersion without a remount key",
  async (name, toolId) => {
    const client = createTestQueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <ChimeraApp providerRefreshVersion={0} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name }));
    expect(await screen.findByText(`tool:${toolId}:refresh:0`)).toBeVisible();
    view.rerender(
      <QueryClientProvider client={client}>
        <ChimeraApp providerRefreshVersion={1} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(`tool:${toolId}:refresh:1`)).toBeVisible();
  },
);

it("keeps Claude tools adjacent and opens oh-my-pi as an independent page", async () => {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ChimeraApp />
    </QueryClientProvider>,
  );
  const code = screen.getByRole("button", { name: "Claude Code" });
  const desktop = screen.getByRole("button", {
    name: "Claude Desktop",
  });
  expect(code.nextElementSibling).toBe(desktop);
  fireEvent.click(screen.getByRole("button", { name: "oh-my-pi" }));
  expect(
    await screen.findByRole("heading", { name: "oh-my-pi" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "模型线路" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "插件市场" }));
  expect(screen.getByText("原生市场")).toBeVisible();
  expect(screen.queryByText("精选推荐 · 10")).not.toBeInTheDocument();
});
