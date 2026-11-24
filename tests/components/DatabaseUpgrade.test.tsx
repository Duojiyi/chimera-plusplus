import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { exit } from "@tauri-apps/plugin-process";
import { DatabaseUpgrade } from "@/components/DatabaseUpgrade";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  exit: vi.fn(),
}));

const payload = {
  path: "C:\\Users\\user\\.chimera-plus-plus\\chimera.db",
  error: "Database schema version 25 is newer than supported 20",
  kind: "db_version_too_new",
  db_version: 25,
  supported_version: 20,
};

describe("DatabaseUpgrade recovery flow", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("shows checking state initially and transitions to upgradable when an update exists", async () => {
    let resolveCheck: (v: string | null) => void = () => {};
    vi.mocked(invoke).mockImplementation((cmd) => {
      if (cmd === "check_app_update_available") {
        return new Promise((r) => {
          resolveCheck = r;
        });
      }
      return Promise.resolve(null);
    });

    render(<DatabaseUpgrade payload={payload} />);
    expect(screen.getByText(/正在检查可用更新/)).toBeInTheDocument();
    expect(
      screen.getByText(/数据库版本 v25 · 应用支持 v20/),
    ).toBeInTheDocument();

    await act(async () => {
      resolveCheck("2.9.5");
    });

    expect(
      await screen.findByText(/发现新版本 v2.9.5，升级后即可继续使用/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /升级应用/ }),
    ).toBeInTheDocument();
  });

  it("transitions to incompatible when already on the latest version", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    render(<DatabaseUpgrade payload={payload} />);

    expect(await screen.findByText(/升级也无法解决/)).toBeInTheDocument();
    const openReleases = screen.getByRole("button", { name: /打开发布页/ });
    fireEvent.click(openReleases);
    expect(invoke).toHaveBeenCalledWith("open_external", {
      url: "https://github.com/Duojiyi/chimera-plusplus/releases",
    });
  });

  it("streams download progress during updating and transitions to incompatible if install returns false", async () => {
    let progressHandler:
      | ((evt: {
          payload: { downloaded: number; total: number | null };
        }) => void)
      | null = null;
    let resolveInstall: (v: boolean) => void = () => {};
    vi.mocked(listen).mockImplementation(async (_event, cb) => {
      progressHandler = cb as typeof progressHandler;
      return () => {};
    });
    vi.mocked(invoke).mockImplementation((cmd) => {
      if (cmd === "check_app_update_available") return Promise.resolve("2.9.5");
      if (cmd === "install_update_and_restart") {
        return new Promise((r) => {
          resolveInstall = r;
        });
      }
      return Promise.resolve(null);
    });

    render(<DatabaseUpgrade payload={payload} />);
    const upgradeBtn = await screen.findByRole("button", { name: /升级应用/ });
    fireEvent.click(upgradeBtn);

    expect(await screen.findByText(/正在准备更新/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /打开配置目录/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /退出/ })).toBeDisabled();

    await act(async () => {
      progressHandler?.({
        payload: { downloaded: 5 * 1024 * 1024, total: 10 * 1024 * 1024 },
      });
    });

    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("5.0 MB / 10.0 MB")).toBeInTheDocument();

    await act(async () => {
      resolveInstall(false);
    });

    expect(await screen.findByText(/升级也无法解决/)).toBeInTheDocument();
  });

  it("shows error state when upgrade fails and allows retry, opening config dir, or quitting", async () => {
    vi.mocked(listen).mockResolvedValue(() => {});
    vi.mocked(invoke).mockImplementation((cmd) => {
      if (cmd === "check_app_update_available") return Promise.resolve("2.9.5");
      if (cmd === "install_update_and_restart") {
        return Promise.reject(new Error("Signature verification failed"));
      }
      return Promise.resolve(null);
    });

    render(<DatabaseUpgrade payload={payload} />);
    fireEvent.click(await screen.findByRole("button", { name: /升级应用/ }));

    expect(
      await screen.findByText("Signature verification failed"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /重试升级/ }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /打开配置目录/ }));
    expect(invoke).toHaveBeenCalledWith("open_app_config_folder");

    fireEvent.click(screen.getByRole("button", { name: /退出/ }));
    await waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });
});
