import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolName } from "@/components/settings/AboutSection";
import type { HTMLAttributes } from "react";

const mocks = vi.hoisted(() => ({
  getToolVersions: vi.fn(),
  runToolLifecycleAction: vi.fn(),
  probeToolInstallations: vi.fn(),
  getVersion: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ settingsApi: mocks }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: mocks.getVersion }));
vi.mock("framer-motion", () => ({
  useReducedMotion: () => false,
  motion: {
    section: ({
      initial,
      animate,
      transition,
      ...props
    }: HTMLAttributes<HTMLElement> & {
      initial?: unknown;
      animate?: unknown;
      transition?: unknown;
    }) => <section {...props} />,
    div: ({
      initial,
      animate,
      transition,
      ...props
    }: HTMLAttributes<HTMLDivElement> & {
      initial?: unknown;
      animate?: unknown;
      transition?: unknown;
    }) => <div {...props} />,
  },
}));
vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: () => ({
    hasUpdate: false,
    isChecking: false,
    isInstalling: false,
  }),
}));
vi.mock("sonner", () => ({
  toast: {
    success: mocks.success,
    warning: mocks.warning,
    error: mocks.error,
    info: vi.fn(),
  },
}));

const version = (
  name = "claude",
  current: string | null = null,
  broken = false,
) => ({
  name,
  version: current,
  latest_version: "2.0.0",
  installed_but_broken: broken,
  error: broken ? "Node version is unsupported" : null,
  env_type: "windows" as const,
  wsl_distro: null,
});

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.getToolVersions.mockImplementation(async (tools: string[]) =>
    tools.map((tool) => version(tool)),
  );
  mocks.runToolLifecycleAction.mockResolvedValue(undefined);
  mocks.probeToolInstallations.mockResolvedValue([]);
});

async function mount(tools?: readonly ToolName[]) {
  const { AboutSection } = await import("@/components/settings/AboutSection");
  return render(<AboutSection isPortable={false} toolsOnly tools={tools} />);
}

describe("shared tool lifecycle management", () => {
  it("shows one status line and skeleton cards, then reveals each card as its result arrives", async () => {
    const pending = new Map<string, (rows: unknown[]) => void>();
    mocks.getToolVersions.mockImplementation(
      ([tool]: string[]) =>
        new Promise((resolve) => {
          pending.set(tool, resolve);
        }),
    );
    const { container } = await mount(["claude", "codex"]);
    const busyCards = () => container.querySelectorAll('[aria-busy="true"]');
    expect(screen.getByRole("status")).toHaveTextContent("正在检测本机工具…");
    expect(busyCards()).toHaveLength(2);
    expect(screen.queryByText("common.loading")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "common.refresh" }),
    ).toBeDisabled();
    await act(async () => pending.get("claude")!([version("claude", "1.0.0")]));
    expect(screen.getByText("1.0.0")).toBeVisible();
    expect(busyCards()).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("正在检测本机工具…");
    await act(async () => pending.get("codex")!([version("codex", "2.0.0")]));
    expect(busyCards()).toHaveLength(0);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(
      screen.getByRole("button", { name: "common.refresh" }),
    ).toBeEnabled();
  });

  it("detects and installs only the requested tool without loading the app update UI", async () => {
    mocks.getToolVersions
      .mockResolvedValueOnce([version()])
      .mockResolvedValueOnce([version("claude", "2.0.0")]);
    await mount(["claude"]);
    const install = await screen.findByRole("button", {
      name: "settings.toolInstall",
    });
    expect(screen.getByText("common.notInstalled")).toBeVisible();
    expect(mocks.getToolVersions).toHaveBeenCalledWith(["claude"], {});
    expect(mocks.getVersion).not.toHaveBeenCalled();
    fireEvent.click(install);
    await waitFor(() => expect(mocks.success).toHaveBeenCalled());
    expect(mocks.runToolLifecycleAction).toHaveBeenCalledWith(
      ["claude"],
      "install",
      {},
    );
    expect(mocks.getToolVersions).toHaveBeenCalledTimes(2);
    expect(screen.getByText("settings.toolReady")).toBeVisible();
  });

  it("does not label a detected but broken installation as missing or offer reinstall", async () => {
    mocks.getToolVersions.mockResolvedValue([version("claude", null, true)]);
    await mount(["claude"]);
    expect(
      await screen.findByText("settings.installedNotRunnable"),
    ).toBeVisible();
    expect(screen.getByText("settings.toolCheckEnv")).toBeVisible();
    expect(screen.queryByText("common.notInstalled")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "settings.toolInstall" }),
    ).not.toBeInTheDocument();
  });

  it.each(["rejected", "incomplete"])(
    "does not invent an uninstalled state after a %s detection",
    async (failure) => {
      if (failure === "rejected")
        mocks.getToolVersions.mockRejectedValue(new Error("IPC unavailable"));
      else mocks.getToolVersions.mockResolvedValue([]);
      await mount(["claude"]);
      expect(await screen.findByText("检测失败，请刷新重试")).toBeVisible();
      expect(screen.queryByText("common.notInstalled")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "settings.toolInstall" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "settings.updateAllTools" }),
      ).toBeDisabled();
    },
  );

  it("probes missing tools rather than treating a single-tool cache as a complete registry", async () => {
    const first = await mount(["claude"]);
    await screen.findByText("common.notInstalled");
    first.unmount();
    await mount();
    await waitFor(() => expect(mocks.getToolVersions).toHaveBeenCalledTimes(8));
    for (const tool of [
      "codex",
      "gemini",
      "grok",
      "opencode",
      "openclaw",
      "hermes",
    ])
      expect(mocks.getToolVersions).toHaveBeenCalledWith([tool], {});
  });

  it("invalidates failed cached detection and retries on remount", async () => {
    mocks.getToolVersions
      .mockResolvedValueOnce([version("claude", "1.0.0")])
      .mockRejectedValueOnce(new Error("IPC unavailable"))
      .mockResolvedValueOnce([version("claude", "2.0.0")]);
    const first = await mount(["claude"]);
    await screen.findByText("1.0.0");
    fireEvent.click(screen.getByRole("button", { name: "common.refresh" }));
    await screen.findByText("检测失败，请刷新重试");
    expect(
      screen.getByRole("button", { name: "settings.updateAllTools" }),
    ).toBeDisabled();
    first.unmount();
    await mount(["claude"]);
    await screen.findByText("settings.toolReady");
    expect(mocks.getToolVersions).toHaveBeenCalledTimes(3);
  });

  it("verifies the version after upgrading and reports an unchanged version instead of success", async () => {
    mocks.getToolVersions.mockResolvedValue([version("claude", "1.0.0")]);
    await mount(["claude"]);
    fireEvent.click(
      await screen.findByRole("button", { name: "settings.toolUpdate" }),
    );
    await waitFor(() => expect(mocks.warning).toHaveBeenCalled());
    expect(mocks.probeToolInstallations).toHaveBeenCalledWith(["claude"]);
    expect(mocks.runToolLifecycleAction).toHaveBeenCalledWith(
      ["claude"],
      "update",
      {},
    );
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("does not report a successful command as a working installation when the tool cannot run", async () => {
    mocks.getToolVersions
      .mockResolvedValueOnce([version()])
      .mockResolvedValueOnce([version("claude", null, true)]);
    await mount(["claude"]);
    fireEvent.click(
      await screen.findByRole("button", { name: "settings.toolInstall" }),
    );
    await waitFor(() =>
      expect(mocks.warning).toHaveBeenCalledWith(
        "settings.toolActionInstalledNotRunnable",
        expect.anything(),
      ),
    );
    expect(mocks.success).not.toHaveBeenCalled();
  });
});
