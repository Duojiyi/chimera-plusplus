import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StationSignboard } from "@/components/StationSignboard";
import { CANONICAL_PROVIDERS, CANONICAL_STATION } from "@/data/canonicalData";
import type { Provider } from "@/types";

const provider: Provider = { id: "custom", name: "", settingsConfig: {} };

describe("station signboard uses measured data", () => {
  it("keeps unknown state explicit without fixture claims or actions", () => {
    render(<StationSignboard currentProvider={provider} />);
    expect(screen.getByText("未命名线路")).toBeVisible();
    expect(screen.getByText("未设置请求地址")).toBeVisible();
    expect(screen.getByText("未设置模型")).toBeVisible();
    expect(screen.getByText("未测速", { selector: ".station-state" })).toBeVisible();
    // No protocol persisted: the line goes through the local router for auto-detection.
    expect(screen.getByText("自动识别协议")).toBeVisible();
    expect(
      screen.getByRole("list", { name: "请求路径：经 Chimera++ 本地路由" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "切回" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("暂无本次会话的切换记录"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "测速" })).toBeDisabled();
    expect(document.body.textContent).not.toMatch(
      /DeepSeek|182|0\.61\.0|HTTP 200|128K|#0412/,
    );
  });

  it("shows a zero millisecond measurement and hides it as current during a new test", () => {
    const { rerender } = render(
      <StationSignboard currentProvider={provider} latencyMs={0} />,
    );
    expect(screen.getByText("0 ms")).toBeVisible();
    expect(screen.getByText("地址可达", { selector: ".station-state" })).toBeVisible();
    rerender(
      <StationSignboard
        currentProvider={provider}
        latencyMs={0}
        testingLatency
      />,
    );
    expect(screen.getByText("测速中", { selector: ".station-state" })).toBeVisible();
    expect(screen.queryByText("0 ms")).not.toBeInTheDocument();
    expect(screen.queryByText("地址可达")).not.toBeInTheDocument();
  });

  it("labels a native Responses provider as a direct API-key line", () => {
    render(
      <StationSignboard
        currentProvider={{
          ...provider,
          meta: { apiFormat: "openai_responses" },
        }}
      />,
    );
    // The kind label names the auth method only; protocol is not mixed in.
    expect(screen.getByText("第三方 · API 密钥")).toBeVisible();
    expect(screen.queryByText(/Responses/)).not.toBeInTheDocument();
    // Native Responses needs no local router.
    expect(screen.getByRole("list", { name: "请求路径：直连" })).toBeVisible();
    expect(screen.getByText("直连 · 未测速")).toBeVisible();
    expect(screen.queryByText("本地路由")).not.toBeInTheDocument();
  });

  it("does not label a UI receipt as a persisted backup", () => {
    render(
      <StationSignboard
        currentProvider={provider}
        undoReceipt={{
          fromName: "Alpha",
          toName: "Beta",
          backupId: "sw-123",
          timestamp: "刚刚",
          onUndo: vi.fn(),
        }}
      />,
    );
    expect(screen.getByText("刚刚 从 Alpha 切换到 Beta")).toBeVisible();
    expect(screen.getByRole("button", { name: /切回/ })).toBeEnabled();
    expect(document.body.textContent).not.toMatch(/备份|sw-123|已写入/);
  });
});

describe("station design sample isolation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const sampleProvider = CANONICAL_PROVIDERS.find(
    (p) => p.id === CANONICAL_STATION.providerId,
  )!;
  it("renders an explicitly labelled sample with all actions disabled", () => {
    const action = vi.fn();
    render(
      <StationSignboard
        currentProvider={sampleProvider}
        designSample={CANONICAL_STATION}
        onEdit={action}
        onTestSpeed={action}
        onOpenCodex={action}
        undoReceipt={{
          fromName: "a",
          toName: "b",
          backupId: "test",
          timestamp: "now",
          onUndo: action,
        }}
      />,
    );
    expect(screen.getByLabelText("设计示例站牌，非本机运行状态")).toBeVisible();
    expect(screen.getByText(CANONICAL_STATION.runtimeLabel)).toBeVisible();
    expect(screen.getByText(CANONICAL_STATION.receipt)).toBeVisible();
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(action).not.toHaveBeenCalled();
  });
  it.each(["mismatched provider", "production", "Tauri"])(
    "rejects design samples for %s",
    (mode) => {
      if (mode === "production") vi.stubEnv("DEV", false);
      if (mode === "Tauri") vi.stubGlobal("__TAURI_INTERNALS__", {});
      render(
        <StationSignboard
          currentProvider={
            mode === "mismatched provider" ? provider : sampleProvider
          }
          designSample={CANONICAL_STATION}
        />,
      );
      expect(
        screen.queryByLabelText("设计示例站牌，非本机运行状态"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(CANONICAL_STATION.receipt),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText("未测速", { selector: ".station-state" }),
      ).toBeVisible();
    },
  );
  it.each([-1, NaN, Infinity])(
    "does not treat invalid latency %s as measured",
    (latencyMs) => {
      render(
        <StationSignboard currentProvider={provider} latencyMs={latencyMs} />,
      );
      expect(
        screen.getByText("未测速", { selector: ".station-state" }),
      ).toBeVisible();
      expect(screen.queryByText("地址可达")).not.toBeInTheDocument();
      expect(screen.getByText("— ms")).toBeVisible();
    },
  );
});
