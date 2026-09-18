import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { NewProvidersView } from "@/ChimeraApp";
import type { Provider } from "@/types";
import { createTestQueryClient } from "../utils/testQueryClient";

const dismissUpdateMock = vi.fn();
const installUpdateMock = vi.fn().mockResolvedValue(true);
const { useUpdateMock } = vi.hoisted(() => ({
  useUpdateMock: vi.fn(),
}));

vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: () => useUpdateMock(),
}));

const mockProvider: Provider = {
  id: "relay-1",
  name: "ChimeraHub Relay",
  settingsConfig: {
    config:
      'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://api.chimerahub.org/v1"\n',
  },
  category: "third_party",
  sortIndex: 0,
  createdAt: Date.now(),
};

function makeProps(
  overrides: Partial<Parameters<typeof NewProvidersView>[0]> = {},
) {
  return {
    providers: [mockProvider],
    currentId: mockProvider.id,
    currentSource: "live" as const,
    connection: { kind: "unknown" as const, message: "" },
    loading: false,
    codexProcess: null,
    launchingCodex: false,
    restartRequired: false,
    onOpenCodex: vi.fn().mockResolvedValue(undefined),
    onSwitch: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn().mockResolvedValue(true),
    deletingProviderId: null,
    onEdit: vi.fn(),
    onAdd: vi.fn(),
    ...overrides,
  };
}

function renderView(
  overrides: Partial<Parameters<typeof NewProvidersView>[0]> = {},
) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <NewProvidersView {...makeProps(overrides)} />
    </QueryClientProvider>,
  );
}

describe("providers update banner", () => {
  it("shows the verified update banner with a direct install action", () => {
    useUpdateMock.mockReturnValue({
      hasUpdate: true,
      isDismissed: false,
      updateInfo: { availableVersion: "2.1.4", currentVersion: "2.1.3" },
      dismissUpdate: dismissUpdateMock,
      installUpdate: installUpdateMock,
      isInstalling: false,
      downloadProgress: null,
    });

    renderView();

    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("Chimera++ 2.1.4 可用");
    expect(banner).toHaveTextContent("发现新版本，下载并验证后安装。");
    expect(screen.getByRole("button", { name: /稍后/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /下载并安装/ }),
    ).toBeInTheDocument();
  });

  it("does not show the banner when no update is available", () => {
    useUpdateMock.mockReturnValue({
      hasUpdate: false,
      isDismissed: false,
      updateInfo: null,
      dismissUpdate: dismissUpdateMock,
    });

    renderView();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("does not show the banner after the update was dismissed", () => {
    useUpdateMock.mockReturnValue({
      hasUpdate: true,
      isDismissed: true,
      updateInfo: { availableVersion: "2.1.4", currentVersion: "2.1.3" },
      dismissUpdate: dismissUpdateMock,
    });

    renderView();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("does not show the banner without update metadata", () => {
    useUpdateMock.mockReturnValue({
      hasUpdate: true,
      isDismissed: false,
      updateInfo: null,
      dismissUpdate: dismissUpdateMock,
    });

    renderView();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("dismisses the banner when the user chooses to defer it", () => {
    useUpdateMock.mockReturnValue({
      hasUpdate: true,
      isDismissed: false,
      updateInfo: { availableVersion: "2.1.4", currentVersion: "2.1.3" },
      dismissUpdate: dismissUpdateMock,
    });

    renderView();
    fireEvent.click(screen.getByRole("button", { name: /稍后/ }));
    expect(dismissUpdateMock).toHaveBeenCalledOnce();
  });

  it("starts installation without dismissing the update", () => {
    useUpdateMock.mockReturnValue({
      hasUpdate: true,
      isDismissed: false,
      updateInfo: { availableVersion: "2.1.4", currentVersion: "2.1.3" },
      dismissUpdate: dismissUpdateMock,
      installUpdate: installUpdateMock,
      isInstalling: false,
      downloadProgress: null,
    });

    renderView();
    fireEvent.click(screen.getByRole("button", { name: /下载并安装/ }));
    expect(dismissUpdateMock).not.toHaveBeenCalled();
    expect(installUpdateMock).toHaveBeenCalledOnce();
  });

  it("says the staged package is ready to install", () => {
    useUpdateMock.mockReturnValue({
      hasUpdate: true,
      isDismissed: false,
      updateInfo: { availableVersion: "2.1.4", currentVersion: "2.1.3" },
      dismissUpdate: dismissUpdateMock,
      stagedVersion: "2.1.4",
      installUpdate: installUpdateMock,
      isInstalling: false,
      downloadProgress: null,
    });

    renderView();
    expect(screen.getByRole("status")).toHaveTextContent(
      "安装包已下载并通过验证",
    );
    expect(
      screen.getByRole("button", { name: /安装并重启/ }),
    ).toBeInTheDocument();
  });

  it("disables the action and shows progress while installing", () => {
    useUpdateMock.mockReturnValue({
      hasUpdate: true,
      isDismissed: false,
      updateInfo: { availableVersion: "2.1.4", currentVersion: "2.1.3" },
      dismissUpdate: dismissUpdateMock,
      installUpdate: installUpdateMock,
      isInstalling: true,
      downloadProgress: { downloaded: 60, total: 100 },
    });

    renderView();

    expect(screen.getByRole("status")).toHaveTextContent("正在下载 60%");
    expect(screen.getByRole("button", { name: /正在更新…/ })).toBeDisabled();
  });

  it("does not advertise a stale staged package as ready", () => {
    useUpdateMock.mockReturnValue({
      hasUpdate: true,
      isDismissed: false,
      updateInfo: { availableVersion: "2.1.4", currentVersion: "2.1.3" },
      dismissUpdate: dismissUpdateMock,
      stagedVersion: "2.1.3",
    });

    renderView();
    const banner = screen.getByRole("status");
    expect(banner).not.toHaveTextContent("安装包已下载并通过验证");
    expect(banner).toHaveTextContent("发现新版本，下载并验证后安装。");
  });

  it("handles download/install error gracefully when user clicks install", async () => {
    const failingInstall = vi
      .fn()
      .mockRejectedValue(new Error("Network timeout"));
    useUpdateMock.mockReturnValue({
      hasUpdate: true,
      isDismissed: false,
      updateInfo: { availableVersion: "2.1.4", currentVersion: "2.1.3" },
      dismissUpdate: dismissUpdateMock,
      installUpdate: failingInstall,
      isInstalling: false,
      downloadProgress: null,
    });

    renderView();
    fireEvent.click(screen.getByRole("button", { name: /下载并安装/ }));
    expect(failingInstall).toHaveBeenCalledOnce();
  });
});

describe("route manager delete actions", () => {
  it("deletes an inactive line directly without switching or opening the editor", () => {
    useUpdateMock.mockReturnValue({ hasUpdate: false });
    const spare = { ...mockProvider, id: "spare", name: "备用测试线路" };
    const onDelete = vi.fn().mockResolvedValue(true);
    const onEdit = vi.fn();
    const onSwitch = vi.fn();
    renderView({
      providers: [mockProvider, spare],
      onDelete,
      onEdit,
      onSwitch,
    });
    fireEvent.click(screen.getByRole("button", { name: "管理线路" }));
    fireEvent.click(screen.getByRole("button", { name: "删除备用测试线路" }));
    expect(onDelete).toHaveBeenCalledWith(spare);
    expect(onEdit).not.toHaveBeenCalled();
    expect(onSwitch).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "管理线路" }),
    ).toBeInTheDocument();
    const activeDelete =
      screen.getByTitle("当前线路正在使用，请先切换到其他线路");
    expect(activeDelete).toBeDisabled();
    fireEvent.click(activeDelete);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("disables delete actions while deleting and never offers deletion for the official account", () => {
    useUpdateMock.mockReturnValue({ hasUpdate: false });
    const spare = { ...mockProvider, id: "spare", name: "备用测试线路" };
    const official = {
      ...mockProvider,
      id: "codex-official",
      name: "官方账户",
      category: "official" as const,
    };
    const onDelete = vi.fn().mockResolvedValue(true);
    renderView({
      providers: [mockProvider, spare, official],
      deletingProviderId: spare.id,
      onDelete,
    });
    fireEvent.click(screen.getByRole("button", { name: "管理线路" }));
    const button = screen.getByRole("button", { name: "删除备用测试线路" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onDelete).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "删除官方账户" }),
    ).not.toBeInTheDocument();
  });
});
