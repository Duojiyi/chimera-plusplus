import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { Settings } from "@/types";

const mocks = vi.hoisted(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
  return {
    get: vi.fn(),
    patch: vi.fn(),
    save: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    invoke: vi.fn(),
  };
});
vi.mock("@/lib/api/settings", () => ({
  settingsApi: {
    get: mocks.get,
    patchPreferences: mocks.patch,
    save: mocks.save,
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error },
}));
import { NewRuntimeView } from "@/ChimeraApp";

type Props = ComponentProps<typeof NewRuntimeView>;
const runtime = {
  supported: true,
  installed: true,
  version: "1.2.0",
  installMode: "standard",
  installPath: "C:\Codex",
  canRepair: true,
  canRollback: true,
  canUninstall: true,
};
const release = {
  currentVersion: "1.2.0",
  latestVersion: "1.3.0",
  updateAvailable: true,
  installMode: "standard",
  source: "auto",
  sizeBytes: 0,
};
const initial = {
  codexInstallMode: "portable",
  codexUpdateSource: "mirror",
  checkCodexUpdatesOnStart: false,
  currentProviderCodex: "active",
} as Settings;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function renderRuntime(overrides: Partial<Props> = {}) {
  const props: Props = {
    runtime,
    release: null,
    progress: null,
    operation: null,
    onCheck: vi.fn(),
    onAction: vi.fn(),
    onDiagnose: vi.fn(),
    diagnosing: false,
    ...overrides,
  };
  return { ...render(<NewRuntimeView {...props} />), props };
}
async function openPreferences() {
  const button = screen.getByRole("button", { name: "安装方式与更新源" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}
const portableButton = () =>
  screen.getByRole("button", { name: /免安装版 便携运行/ });
const standardButton = () =>
  screen.getByRole("button", { name: /标准安装 自动集成/ });
const mirrorButton = () => screen.getByRole("button", { name: "镜像安装" });

describe("runtime persisted preferences", () => {
  beforeEach(() => {
    mocks.get.mockReset().mockResolvedValue({ ...initial });
    mocks.patch
      .mockReset()
      .mockImplementation(async (patch) => ({ ...initial, ...patch }));
    mocks.invoke.mockReset().mockResolvedValue([]);
  });

  it("waits for persisted preferences before manual checks and shows the actual startup setting", async () => {
    const load = deferred<Settings>();
    mocks.get.mockReturnValueOnce(load.promise);
    const { props } = renderRuntime();
    const check = screen.getByRole("button", { name: "检查更新" });
    expect(check).toBeDisabled();
    expect(screen.queryByText("已开启")).not.toBeInTheDocument();
    fireEvent.click(check);
    expect(props.onCheck).not.toHaveBeenCalled();
    await act(async () => load.resolve(initial));
    expect(screen.getByText("已关闭")).toBeInTheDocument();
    expect(screen.getByText("镜像源")).toBeInTheDocument();
    expect(screen.getByText(runtime.installPath)).toBeInTheDocument();
    fireEvent.click(check);
    expect(props.onCheck).toHaveBeenCalledWith({
      source: "mirror",
      installMode: "portable",
    });
    await openPreferences();
    expect(portableButton()).toHaveAttribute("aria-pressed", "true");
    expect(mirrorButton()).toHaveAttribute("aria-pressed", "true");
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("retains saved choices across conflicting runtime/release refreshes and uses them for install and recheck", async () => {
    const { props, rerender } = renderRuntime();
    await openPreferences();
    rerender(
      <NewRuntimeView
        {...props}
        runtime={{ ...runtime, version: "1.2.1" }}
        release={release}
      />,
    );
    expect(portableButton()).toHaveAttribute("aria-pressed", "true");
    expect(mirrorButton()).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "关闭安装与维护" }));
    fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
    expect(props.onCheck).toHaveBeenCalledWith({
      source: "mirror",
      installMode: "portable",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "下载并安装 免安装版" }),
    );
    expect(props.onAction).toHaveBeenCalledWith("update", {
      source: "mirror",
      installMode: "portable",
    });
    expect(screen.getByText("标准安装")).toBeInTheDocument();
  });

  it("reports initialization failure, prevents fallback operations, and retries", async () => {
    mocks.get.mockRejectedValueOnce(new Error("read failed"));
    const { props } = renderRuntime({ release });
    await screen.findByRole("alert");
    expect(mocks.error).toHaveBeenCalledWith("读取更新偏好失败", {
      description: "Error: read failed",
    });
    expect(
      screen.getByRole("button", { name: "下载并安装 标准安装" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "重新检查" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "安装方式与更新源" }),
    ).toBeDisabled();
    expect(screen.queryByText("已开启")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试读取更新偏好" }));
    const install = await screen.findByRole("button", {
      name: "下载并安装 免安装版",
    });
    await waitFor(() => expect(install).toBeEnabled());
    fireEvent.click(install);
    expect(props.onAction).toHaveBeenCalledWith("update", {
      source: "mirror",
      installMode: "portable",
    });
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it("queues concurrent field saves using patches and blocks operations until all saves finish", async () => {
    mocks.get.mockResolvedValueOnce({
      ...initial,
      codexInstallMode: "standard",
      codexUpdateSource: "auto",
    });
    const first = deferred<Settings>();
    const second = deferred<Settings>();
    mocks.patch
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { props } = renderRuntime({ release });
    await openPreferences();
    fireEvent.click(portableButton());
    fireEvent.click(mirrorButton());
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    expect(mocks.patch).toHaveBeenNthCalledWith(1, {
      codexInstallMode: "portable",
    });
    expect(portableButton()).toBeDisabled();
    expect(mirrorButton()).toBeDisabled();
    for (const button of screen.getAllByRole("button", {
      name: "下载并安装 标准安装",
    }))
      expect(button).toBeDisabled();
    expect(screen.getByRole("button", { name: "重新检查" })).toBeDisabled();
    await act(async () =>
      first.resolve({ ...initial, codexUpdateSource: "auto" }),
    );
    expect(mocks.patch).toHaveBeenNthCalledWith(2, {
      codexUpdateSource: "mirror",
    });
    expect(screen.getByRole("button", { name: "重新检查" })).toBeDisabled();
    await act(async () => second.resolve(initial));
    expect(portableButton()).toHaveAttribute("aria-pressed", "true");
    expect(mirrorButton()).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(
      screen.getAllByRole("button", { name: "下载并安装 免安装版" })[1],
    );
    expect(props.onAction).toHaveBeenCalledWith("update", {
      source: "mirror",
      installMode: "portable",
    });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it.each(["codexInstallMode", "codexUpdateSource"] as const)(
    "keeps confirmed %s on failed save and permits retry",
    async (field) => {
      mocks.patch.mockRejectedValueOnce(new Error("disk full"));
      const { props } = renderRuntime();
      await openPreferences();
      const target =
        field === "codexInstallMode"
          ? standardButton()
          : screen.getByRole("button", { name: "自动选择" });
      fireEvent.click(target);
      await waitFor(() =>
        expect(mocks.error).toHaveBeenCalledWith("保存更新偏好失败", {
          description: "Error: disk full",
        }),
      );
      expect(target).toBeEnabled();
      expect(target).toHaveAttribute("aria-pressed", "false");
      expect(mocks.success).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
      expect(props.onCheck).toHaveBeenLastCalledWith({
        source: "mirror",
        installMode: "portable",
      });
      fireEvent.click(target);
      await waitFor(() =>
        expect(target).toHaveAttribute("aria-pressed", "true"),
      );
      fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
      expect(props.onCheck).toHaveBeenLastCalledWith({
        source: field === "codexUpdateSource" ? "auto" : "mirror",
        installMode: field === "codexInstallMode" ? "standard" : "portable",
      });
    },
  );

  it("continues queued saves after one fails without applying the failed choice", async () => {
    const failed = deferred<Settings>();
    mocks.patch.mockReturnValueOnce(failed.promise);
    const { props } = renderRuntime();
    await openPreferences();
    fireEvent.click(standardButton());
    fireEvent.click(screen.getByRole("button", { name: "自动选择" }));
    await act(async () => failed.reject(new Error("disk full")));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(2));
    expect(portableButton()).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "自动选择" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(props.onCheck).toHaveBeenCalledWith({
      source: "auto",
      installMode: "portable",
    });
  });

  it("reads saved choices again after leaving the page, even when runtime still reports the old install mode", async () => {
    let saved = {
      ...initial,
      codexInstallMode: "standard" as const,
    } as Settings;
    mocks.get.mockImplementation(async () => saved);
    mocks.patch.mockImplementation(
      async (patch) => (saved = { ...saved, ...patch }),
    );
    const first = renderRuntime();
    await openPreferences();
    fireEvent.click(portableButton());
    await waitFor(() =>
      expect(portableButton()).toHaveAttribute("aria-pressed", "true"),
    );
    first.unmount();
    const second = renderRuntime();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "检查更新" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(second.props.onCheck).toHaveBeenCalledWith({
      source: "mirror",
      installMode: "portable",
    });
  });

  it.each([false, true])(
    "waits across remounts for both queued writes (second fails: %s)",
    async (secondFails) => {
      let saved = {
        ...initial,
        codexInstallMode: "standard",
        codexUpdateSource: "auto",
      } as Settings;
      const firstWrite = deferred<Settings>();
      const secondWrite = deferred<Settings>();
      mocks.get.mockImplementation(async () => ({ ...saved }));
      mocks.patch
        .mockImplementationOnce(() =>
          firstWrite.promise.then((value) => (saved = value)),
        )
        .mockImplementationOnce(() =>
          secondWrite.promise.then((value) => (saved = value)),
        )
        .mockImplementation(async (patch) => (saved = { ...saved, ...patch }));
      const first = renderRuntime({ release });
      await openPreferences();
      fireEvent.click(portableButton());
      fireEvent.click(mirrorButton());
      await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
      first.unmount();
      const second = renderRuntime({ release });
      // Flush initialization microtasks while neither write has completed.
      await act(async () => {});
      expect(mocks.get).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "重新检查" })).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "下载并安装 标准安装" }),
      ).toBeDisabled();
      await act(async () =>
        firstWrite.resolve({ ...initial, codexUpdateSource: "auto" }),
      );
      expect(mocks.patch).toHaveBeenNthCalledWith(2, {
        codexUpdateSource: "mirror",
      });
      expect(mocks.get).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "重新检查" })).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "下载并安装 标准安装" }),
      ).toBeDisabled();
      await act(async () => {
        if (secondFails) secondWrite.reject(new Error("disk full"));
        else secondWrite.resolve({ ...initial });
      });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "重新检查" })).toBeEnabled(),
      );
      expect(mocks.get).toHaveBeenCalledTimes(2);
      // Unmounted views must not emit stale successful-save callbacks.
      expect(mocks.success).not.toHaveBeenCalled();
      const expected = {
        source: secondFails ? "auto" : "mirror",
        installMode: "portable",
      };
      fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
      expect(second.props.onCheck).toHaveBeenLastCalledWith(expected);
      fireEvent.click(
        screen.getByRole("button", { name: "下载并安装 免安装版" }),
      );
      expect(second.props.onAction).toHaveBeenLastCalledWith(
        "update",
        expected,
      );
      expect(first.props.onCheck).not.toHaveBeenCalled();
      expect(first.props.onAction).not.toHaveBeenCalled();
      await openPreferences();
      expect(portableButton()).toHaveAttribute("aria-pressed", "true");
      expect(mirrorButton()).toHaveAttribute(
        "aria-pressed",
        String(!secondFails),
      );
      if (secondFails) {
        expect(mocks.error).toHaveBeenCalledWith("保存更新偏好失败", {
          description: "Error: disk full",
        });
        fireEvent.click(mirrorButton());
        await waitFor(() =>
          expect(mirrorButton()).toHaveAttribute("aria-pressed", "true"),
        );
        fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
        expect(second.props.onCheck).toHaveBeenLastCalledWith({
          source: "mirror",
          installMode: "portable",
        });
      }
    },
  );

  it("ignores a late initialization response from an unmounted page", async () => {
    const oldLoad = deferred<Settings>();
    mocks.get.mockReturnValueOnce(oldLoad.promise);
    const first = renderRuntime();
    first.unmount();
    const second = renderRuntime();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "检查更新" })).toBeEnabled(),
    );
    await act(async () =>
      oldLoad.resolve({
        ...initial,
        codexInstallMode: "standard",
        codexUpdateSource: "auto",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(second.props.onCheck).toHaveBeenCalledWith({
      source: "mirror",
      installMode: "portable",
    });
  });

  it("uses defaults only after a successful read and does not claim an absent runtime is ready", async () => {
    mocks.get.mockResolvedValueOnce({});
    const { props, rerender } = renderRuntime({ runtime: null });
    expect(
      screen.getByRole("heading", { name: "正在识别本机 Codex" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "检查更新" })).toBeEnabled(),
    );
    expect(screen.getByText("已开启")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(props.onCheck).toHaveBeenCalledWith({
      source: "auto",
      installMode: "standard",
    });
    rerender(
      <NewRuntimeView {...props} runtime={{ ...runtime, installed: false }} />,
    );
    expect(
      screen.getByRole("heading", { name: "尚未安装 Codex" }),
    ).toBeInTheDocument();
    rerender(
      <NewRuntimeView
        {...props}
        runtime={{ ...runtime, installMode: null, installPath: null }}
      />,
    );
    expect(screen.getByText("未识别安装方式")).toBeInTheDocument();
    expect(screen.getByText("路径未识别")).toBeInTheDocument();
  });
  it("does not overwrite a newly saved choice when runtime or release changes", async () => {
    const { props, rerender } = renderRuntime({ release });
    await openPreferences();
    fireEvent.click(standardButton());
    await waitFor(() =>
      expect(standardButton()).toHaveAttribute("aria-pressed", "true"),
    );
    rerender(
      <NewRuntimeView
        {...props}
        runtime={{ ...runtime, installMode: "portable" }}
        release={{ ...release, source: "mirror" }}
      />,
    );
    expect(standardButton()).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(
      screen.getAllByRole("button", { name: "下载并安装 标准安装" })[1],
    );
    expect(props.onAction).toHaveBeenCalledWith("update", {
      source: "mirror",
      installMode: "standard",
    });
  });

  it("passes the persisted install mode to historical installation and refresh", async () => {
    const plan = {
      version: "1.1.0",
      packageVersion: "1.1.0",
      packageMoniker: "Codex",
      packageUrl: "https://example.com/codex.msix",
      sha256: "abc",
      sizeBytes: 0,
    };
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "list_codex_runtime_releases")
        return [{ tag: "v1.1.0", installable: true, prerelease: false }];
      if (command === "plan_codex_runtime_release") return plan;
      return [];
    });
    const onRuntimeChanged = vi.fn();
    renderRuntime({ onRuntimeChanged });
    await openPreferences();
    fireEvent.click(
      screen.getByRole("button", { name: /安装历史版本 从镜像发布目录/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /v1.1.0/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "确认安装此版本" }),
    );
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "install_codex_runtime_release",
        { plan, installMode: "portable", confirm: true },
      ),
    );
    expect(onRuntimeChanged).toHaveBeenCalledWith({
      source: "mirror",
      installMode: "portable",
    });
  });
});
