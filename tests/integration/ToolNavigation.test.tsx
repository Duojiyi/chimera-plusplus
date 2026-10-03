import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
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
it.each([
  ["Claude Desktop", "claude-desktop"],
  ["Grok Build", "grokbuild"],
  ["OpenClaw", "openclaw"],
  ["Hermes", "hermes"],
  ["MiniMax Code", "mcode"],
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
