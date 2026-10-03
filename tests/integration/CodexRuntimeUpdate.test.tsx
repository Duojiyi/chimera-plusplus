import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
});
vi.mock("@/lib/api/settings", () => ({
  settingsApi: {
    get: vi.fn().mockResolvedValue({}),
    patchPreferences: vi.fn().mockImplementation(async (patch) => patch),
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));
import { NewRuntimeView } from "@/ChimeraApp";

const runtime = {
  supported: true,
  installed: true,
  version: "1.2.0",
  installMode: "standard",
  canRepair: true,
  canRollback: false,
  canUninstall: true,
};

function renderRuntime(
  release: {
    currentVersion?: string | null;
    latestVersion: string;
    updateAvailable: boolean;
    installMode: string;
    sizeBytes: number;
    source: string;
  } | null,
) {
  const onCheck = vi.fn();
  const onAction = vi.fn();
  render(
    <NewRuntimeView
      runtime={runtime}
      release={release}
      progress={null}
      operation={null}
      onCheck={onCheck}
      onDiagnose={vi.fn()}
      diagnosing={false}
      onAction={onAction}
    />,
  );
  return { onAction, onCheck };
}

describe("Codex runtime update", () => {
  it("turns the check action into an install action when a Codex release is found", async () => {
    const { onAction, onCheck } = renderRuntime({
      currentVersion: "1.2.0",
      latestVersion: "1.3.0",
      updateAvailable: true,
      installMode: "standard",
      sizeBytes: 12 * 1024 * 1024,
      source: "auto",
    });

    expect(screen.getByRole("status")).toHaveTextContent("Codex 1.3.0 可用");
    expect(
      screen.getByRole("button", { name: "下载并安装 标准安装" }),
    ).toBeInTheDocument();

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "下载并安装 标准安装" }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "下载并安装 标准安装" }),
    );

    expect(onAction).toHaveBeenCalledWith("update", {
      source: "auto",
      installMode: "standard",
    });
    expect(onCheck).not.toHaveBeenCalled();
  });

  it("keeps the selected portable install label across the maintenance drawer", async () => {
    const { onAction } = renderRuntime({
      currentVersion: "1.2.0",
      latestVersion: "1.3.0",
      updateAvailable: true,
      installMode: "standard",
      sizeBytes: 0,
      source: "auto",
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "安装方式与更新源" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "安装方式与更新源" }));
    fireEvent.click(screen.getByRole("button", { name: /免安装版 便携运行/ }));

    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "下载并安装 免安装版" }),
      ).toHaveLength(2),
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "下载并安装 免安装版" })[0],
    );
    expect(onAction).toHaveBeenCalledWith("update", {
      source: "auto",
      installMode: "portable",
    });
  });

  it("checks for updates until a release is available", async () => {
    const { onCheck } = renderRuntime(null);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "检查更新" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));

    expect(onCheck).toHaveBeenCalledOnce();
  });
});
