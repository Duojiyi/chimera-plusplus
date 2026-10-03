import { createElement } from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProviderLineTable } from "@/components/ProviderLineTable";
import type { Provider } from "@/types";

vi.mock("@/lib/api/vscode", () => ({
  vscodeApi: { testApiEndpoints: vi.fn() },
}));

describe("provider table replaces horizontal route cards", () => {
  it("keeps every line accessible in grouped rows without carousel controls", () => {
    const providers: Provider[] = Array.from({ length: 30 }, (_, i) => ({
      id: `line-${i}`,
      name: `Line ${i}`,
      settingsConfig: {},
    }));
    const labels = new Map(
      providers.map((p, i) => [
        p.id,
        {
          name: p.name,
          source: "Configured source",
          mark: "L",
          official: i < 2,
        },
      ]),
    );
    render(
      createElement(ProviderLineTable, {
        providers,
        labels,
        currentId: "line-0",
        switchingId: null,
        deletingProviderId: null,
        onSwitch: vi.fn().mockResolvedValue(undefined),
        onEdit: vi.fn(),
        onDelete: vi.fn().mockResolvedValue(true),
      }),
    );
    const table = screen.getByRole("table", { name: "线路切换" });
    expect(within(table).getAllByRole("rowgroup")).toHaveLength(2);
    expect(within(table).getAllByRole("row")).toHaveLength(33);
    for (const provider of providers)
      expect(within(table).getByText(provider.name)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "显示下一条线路" }),
    ).not.toBeInTheDocument();
  });
});
