import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MiniSignboard } from "@/components/MiniSignboard";
import type { Provider } from "@/types";
import type { ConnectionState } from "@/chimeraUtils";

const provider: Provider = {
  id: "deepseek",
  name: "DeepSeek",
  category: "custom",
  settingsConfig: {},
};

describe("Pencil mini signboard states", () => {
  it.each([
    [{ kind: "connected", message: "ok", modelCount: 0, latencyMs: 0 }, "0 ms"],
    [
      { kind: "connected", message: "ok", modelCount: 0, latencyMs: 182 },
      "182 ms",
    ],
    [
      { kind: "connected", message: "ok", modelCount: 0, latencyMs: 1200 },
      "1200 ms 慢",
    ],
    [{ kind: "checking", message: "checking" }, "测速中…"],
    [{ kind: "error", message: "request failed" }, "连接失败"],
    [{ kind: "unknown", message: "unknown" }, "未测速"],
    [{ kind: "connected", message: "ok", modelCount: 0 }, "未测速"],
  ] as [ConnectionState, string][])(
    "renders an honest reading for %j",
    (connection, reading) => {
      render(
        <MiniSignboard currentProvider={provider} connection={connection} />,
      );
      expect(
        screen.getByRole("button", { name: `当前线路：DeepSeek，${reading}` }),
      ).toBeVisible();
      expect(screen.getByRole("status")).toHaveTextContent(reading);
      expect(screen.getByText("DS")).toBeVisible();
    },
  );

  it("keeps an unselected board without a badge or invented measurement", () => {
    const onClick = vi.fn();
    const { container } = render(
      <MiniSignboard
        currentProvider={null}
        connection={{
          kind: "connected",
          message: "stale",
          modelCount: 0,
          latencyMs: 182,
        }}
        onClick={onClick}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "当前线路：未选择线路" }),
    );
    expect(onClick).toHaveBeenCalledOnce();
    expect(container.querySelector(".mini-signboard-badge")).toBeNull();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
