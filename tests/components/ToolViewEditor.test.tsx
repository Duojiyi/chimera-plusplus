import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ToolViewEditor from "@/views/ToolViewEditor";
import { providersApi } from "@/lib/api/providers";
import { settingsApi } from "@/lib/api/settings";
import type { Provider } from "@/types";

vi.mock("@/lib/api/providers", () => ({
  providersApi: { getCurrent: vi.fn() },
}));
vi.mock("@/lib/api/settings", () => ({
  settingsApi: { getConfigDir: vi.fn(), getClaudeCodeConfigPath: vi.fn() },
}));
vi.mock("@/hooks/useLightweightClose", () => ({
  useLightweightCloseBlocker: () => {},
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The tool's own form; the editor shell around it is under test.
vi.mock("@/components/providers/forms/ProviderForm", () => ({
  ProviderForm: ({ saveSummaryNote }: { saveSummaryNote?: string }) => (
    <p data-testid="summary-note">{saveSummaryNote}</p>
  ),
}));

const line: Provider = { id: "grok-1", name: "Relay", settingsConfig: {} };

beforeEach(() => {
  vi.mocked(providersApi.getCurrent).mockResolvedValue("");
  vi.mocked(settingsApi.getConfigDir).mockResolvedValue("D:\\grok-home");
});

describe("Grok Build / Claude Desktop line editor", () => {
  it("names the tool and its real config directory for the line in use", async () => {
    vi.mocked(providersApi.getCurrent).mockResolvedValue("grok-1");
    render(
      <ToolViewEditor
        appId="grokbuild"
        provider={line}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent(
      "这是正在使用的线路。保存后立即写入 Grok Build 的配置",
    );
    expect(await screen.findByText(/（D:\\grok-home）/)).toBeInTheDocument();
    expect(settingsApi.getConfigDir).toHaveBeenCalledWith("grokbuild");
    expect(screen.getByTestId("summary-note")).toHaveTextContent(
      "保存后立即写入 Grok Build 的配置",
    );
  });

  it("names only the tool when its config location cannot be read", async () => {
    vi.mocked(providersApi.getCurrent).mockResolvedValue("grok-1");
    vi.mocked(settingsApi.getConfigDir).mockRejectedValue(new Error("no"));
    render(
      <ToolViewEditor
        appId="claude-desktop"
        provider={{ ...line, id: "grok-1" }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent(
      "这是正在使用的线路。保存后立即写入 Claude Desktop 的配置，",
    );
    expect(note.textContent).not.toContain("（");
  });

  it("deletes from the header, or says why the line in use cannot be", () => {
    const onDelete = vi.fn();
    const { rerender } = render(
      <ToolViewEditor
        appId="grokbuild"
        provider={line}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /删除线路/ }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    rerender(
      <ToolViewEditor
        appId="grokbuild"
        provider={line}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDelete={onDelete}
        deleteBlockedReason="当前线路正在使用，请先切换到其他线路再删除。"
      />,
    );
    const blocked = screen.getByRole("button", { name: /删除线路/ });
    expect(blocked).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(blocked);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("tells a new line that saving does not write the tool's config", () => {
    render(
      <ToolViewEditor
        appId="grokbuild"
        provider={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /删除线路/ })).toBeNull();
    expect(screen.getByTestId("summary-note")).toHaveTextContent(
      "仅保存到 Chimera++；在列表中切换到这条线路后才写入 Grok Build 的配置。",
    );
  });
});
