import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolView } from "@/views/ToolView";
import { providersApi } from "@/lib/api/providers";

vi.mock("@/lib/api/providers", () => ({
  providersApi: {
    getAll: vi.fn(),
    getCurrent: vi.fn(),
    add: vi.fn(),
    update: vi.fn(),
    switch: vi.fn(),
    removeFromLiveConfig: vi.fn(),
    getClaudeDesktopStatus: vi.fn(),
    importClaudeDesktopFromClaude: vi.fn(),
    ensureClaudeDesktopOfficialProvider: vi.fn(),
    ensureGrokBuildOfficialProvider: vi.fn(),
  },
}));
vi.mock("@/components/settings/AboutSection", () => ({
  AboutSection: ({ tools }: { tools: string[] }) => (
    <p>lifecycle:{tools.join(",")}</p>
  ),
}));
vi.mock("@/components/proxy/ClaudeDesktopRouteToggle", () => ({
  ClaudeDesktopRouteToggle: () => <p>Desktop route toggle</p>,
}));
vi.mock("@/components/common/FullScreenPanel", () => ({
  FullScreenPanel: ({
    children,
    footer,
  }: {
    children: React.ReactNode;
    footer?: React.ReactNode;
  }) => (
    <section aria-label="editor">
      {children}
      {footer}
    </section>
  ),
}));
vi.mock("@/components/JsonEditor", () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (s: string) => void;
  }) => (
    <textarea
      aria-label="JSON"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
vi.mock("@/components/providers/forms/ProviderForm", () => ({
  ProviderForm: ({
    appId,
    onSubmit,
  }: {
    appId: string;
    onSubmit: (v: unknown) => void;
  }) => (
    <div>
      <p>native form:{appId}</p>
      <button
        onClick={() =>
          onSubmit({
            name: "Official",
            settingsConfig: "{}",
            presetCategory: "official",
          })
        }
      >
        Save official
      </button>
      <input aria-label="draft" defaultValue="" />
      <button
        onClick={() =>
          onSubmit({
            name: "Saved",
            providerKey: "saved",
            settingsConfig: JSON.stringify({ nativeApp: appId }),
          })
        }
      >
        Save native
      </button>
    </div>
  ),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(providersApi.getAll).mockResolvedValue({});
  vi.mocked(providersApi.getCurrent).mockResolvedValue("");
  vi.mocked(providersApi.add).mockResolvedValue(true);
  vi.mocked(providersApi.update).mockResolvedValue(true);
  vi.mocked(providersApi.switch).mockResolvedValue({
    warnings: [],
    routingChanged: false,
  });
  vi.mocked(providersApi.getClaudeDesktopStatus).mockResolvedValue({
    supported: true,
    configured: true,
    proxyRunning: false,
    staleRawModels: false,
    missingRouteMappings: false,
    gatewayTokenConfigured: false,
  });
});

describe("additional native tools", () => {
  it.each(["unknown", "constructor", "__proto__"])(
    "rejects %s without invoking Claude",
    (id) => {
      render(<ToolView toolId={id} />);
      expect(screen.getByRole("alert")).toHaveTextContent("不支持的工具");
      expect(providersApi.getAll).not.toHaveBeenCalled();
    },
  );
  it.each(["claude-desktop", "grokbuild"])(
    "opens and saves %s through its native form and appId without activating",
    async (appId) => {
      const view = render(
        <ToolView toolId={appId} native refreshVersion={0} />,
      );
      await waitFor(
        () =>
          expect(
            screen.getByRole("button", { name: "添加线路" }),
          ).toBeEnabled(),
        { timeout: 10000 },
      );
      expect(providersApi.getAll).toHaveBeenCalledWith(appId);
      fireEvent.click(screen.getByRole("button", { name: "添加线路" }));
      await screen.findByText(`native form:${appId}`);
      fireEvent.change(screen.getByLabelText("draft"), {
        target: { value: "unsaved" },
      });
      const reads = vi.mocked(providersApi.getAll).mock.calls.length;
      view.rerender(<ToolView toolId={appId} native refreshVersion={1} />);
      await waitFor(() =>
        expect(providersApi.getAll).toHaveBeenCalledTimes(reads + 1),
      );
      expect(screen.getByLabelText("draft")).toHaveValue("unsaved");
      fireEvent.click(screen.getByText("Save native"));
      await waitFor(() =>
        expect(providersApi.add).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "saved",
            settingsConfig: { nativeApp: appId },
            meta: { liveConfigManaged: false },
          }),
          appId,
          false,
        ),
      );
      expect(providersApi.switch).not.toHaveBeenCalled();
    },
  );

  it.each(["claude-desktop", "grokbuild"])(
    "explicitly activates %s using the same appId",
    async (appId) => {
      vi.mocked(providersApi.getAll).mockResolvedValue({
        p: {
          id: "p",
          name: "Line",
          settingsConfig: {},
          meta: { liveConfigManaged: false },
        },
      });
      render(<ToolView toolId={appId} native />);
      await screen.findByText("Line");
      const button = screen.getByRole("button", {
        name:
          appId === "claude-desktop" || appId === "grokbuild"
            ? "切换"
            : "启用Line",
      });
      await waitFor(() => expect(button).toBeEnabled());
      fireEvent.click(button);
      await waitFor(() =>
        expect(providersApi.switch).toHaveBeenCalledWith("p", appId),
      );
    },
  );
  it("does not claim Desktop is installed or expose unsupported writes", async () => {
    vi.mocked(providersApi.getClaudeDesktopStatus).mockResolvedValue({
      supported: false,
      configured: false,
    } as never);
    render(<ToolView toolId="claude-desktop" native />);
    await screen.findByText(/当前平台不支持 Desktop/);
    expect(screen.getByRole("button", { name: "添加线路" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /从 Claude Code 导入/ }),
    ).toBeDisabled();
    expect(screen.queryByText("Desktop route toggle")).not.toBeInTheDocument();
    expect(screen.getByText("未检测到")).toBeVisible();
    expect(screen.getByText("平台不支持")).toBeVisible();
    expect(screen.getByText("标准路径未检测到")).not.toBeVisible();
  });
});

it("shows an actual Desktop executable independently of configuration", async () => {
  vi.mocked(providersApi.getClaudeDesktopStatus).mockResolvedValue({
    supported: true,
    configured: false,
    installationPath: "C:/Claude/Claude.exe",
  } as never);
  render(<ToolView toolId="claude-desktop" native />);
  expect(
    await screen.findByRole("heading", { name: "已找到本机客户端" }),
  ).toBeVisible();
  expect(screen.getByText("已检测到")).toBeVisible();
  expect(screen.getByText("尚未配置第三方")).toBeVisible();
  expect(screen.getByText("C:/Claude/Claude.exe")).not.toBeVisible();
  fireEvent.click(screen.getByText("诊断与兼容性"));
  expect(screen.getByText("C:/Claude/Claude.exe")).toBeVisible();
});

it.each(["claude-desktop", "grokbuild"])(
  "uses the official seed service for %s without activation",
  async (appId) => {
    render(<ToolView toolId={appId} native />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "添加线路" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "添加线路" }));
    fireEvent.click(await screen.findByText("Save official"));
    await waitFor(() =>
      expect(
        appId === "claude-desktop"
          ? providersApi.ensureClaudeDesktopOfficialProvider
          : providersApi.ensureGrokBuildOfficialProvider,
      ).toHaveBeenCalled(),
    );
    expect(providersApi.add).not.toHaveBeenCalled();
    expect(providersApi.switch).not.toHaveBeenCalled();
  },
);
