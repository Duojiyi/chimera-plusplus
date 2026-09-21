import { StrictMode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Provider } from "@/types";
import type { FetchedModel } from "@/lib/api/model-fetch";

const mocks = vi.hoisted(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
  return {
    getAll: vi.fn(),
    getCurrent: vi.fn(),
    getLive: vi.fn(),
    switchProvider: vi.fn(),
    fetchModels: vi.fn(),
    invoke: vi.fn(),
    listen: vi.fn(),
    toast: {
      error: vi.fn(),
      success: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
    },
  };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/lib/api/providers", async (original) => {
  const api = await original<typeof import("@/lib/api/providers")>();
  return {
    providersApi: {
      ...api.providersApi,
      getAll: mocks.getAll,
      getCurrent: mocks.getCurrent,
      switch: mocks.switchProvider,
    },
  };
});
vi.mock("@/lib/api/model-fetch", () => ({
  fetchModelsForConfig: mocks.fetchModels,
  detectCodexApiFormats: vi.fn(),
}));
vi.mock("@/lib/api/settings", () => ({
  settingsApi: {
    getAppConfigPath: async () => "profile-a",
    get: async () => ({}),
  },
}));
vi.mock("@/lib/api", () => ({
  configApi: { getCommonConfigSnippet: async () => "" },
}));
vi.mock("@/lib/api/vscode", () => ({
  vscodeApi: {
    getLiveProviderSettings: mocks.getLive,
    testApiEndpoints: async () => [{ success: true }],
  },
}));
vi.mock("@/lib/query/queries", () => ({
  useSettingsQuery: () => ({ data: {} }),
}));
vi.mock("@/contexts/UpdateContext", () => ({ useUpdate: () => ({}) }));
vi.mock("@/components/WindowControls", () => ({ WindowControls: () => null }));
vi.mock("@/components/RouteGlobe", () => ({ default: () => null }));
import ChimeraApp from "@/ChimeraApp";
import App from "@/App";

beforeAll(async () => {
  await import("@/components/DeepLinkImportDialog");
}, 30000);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function provider(id: string): Provider {
  return {
    id,
    name: id,
    category: "custom",
    settingsConfig: {
      auth: { OPENAI_API_KEY: "dummy-key" },
      config:
        'model = "gpt-a"\nmodel_provider = "custom"\n[model_providers.custom]\nname = "custom"\nbase_url = "https://example.com/v1"\nwire_api = "responses"',
    },
  };
}
const handlers = new Map<string, Set<(event: { payload: unknown }) => void>>();
const emit = (appType = "codex", providerId = "untrusted-event-id") => {
  act(() =>
    handlers
      .get("provider-switched")
      ?.forEach((handler) => handler({ payload: { appType, providerId } })),
  );
};
function mount(strict = false, child = <ChimeraApp />) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const app = (
    <QueryClientProvider client={client}>{child}</QueryClientProvider>
  );
  return render(strict ? <StrictMode>{app}</StrictMode> : app);
}
async function editAlpha() {
  fireEvent.click(await screen.findByRole("button", { name: "管理线路" }));
  fireEvent.click(screen.getByRole("button", { name: "编辑Alpha" }));
  expect(
    await screen.findByRole("heading", { name: "编辑线路", level: 2 }),
  ).toBeVisible();
}
const fetchButton = () => screen.getByRole("button", { name: "获取模型" });

beforeEach(() => {
  handlers.clear();
  mocks.getAll
    .mockReset()
    .mockResolvedValue({ Alpha: provider("Alpha"), Beta: provider("Beta") });
  mocks.getCurrent.mockReset().mockResolvedValue("Alpha");
  mocks.getLive.mockReset().mockRejectedValue(new Error("no live config"));
  mocks.fetchModels.mockReset();
  mocks.switchProvider
    .mockReset()
    .mockResolvedValue({ warnings: [], routingChanged: false });
  mocks.invoke
    .mockReset()
    .mockImplementation(async (command: string) =>
      command === "get_product_capabilities"
        ? { capabilities: [] }
        : { supported: true, installed: false, running: false },
    );
  mocks.listen
    .mockReset()
    .mockImplementation(
      async (event: string, handler: (event: { payload: unknown }) => void) => {
        const set = handlers.get(event) ?? new Set();
        handlers.set(event, set);
        set.add(handler);
        return () => {
          set.delete(handler);
        };
      },
    );
});
afterEach(cleanup);

describe("Chimera runtime request ownership", () => {
  it("ignores an update check that finishes after uninstall", async () => {
    const pending = deferred<unknown>();
    let installed = true;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "get_product_capabilities") return { capabilities: [] };
      if (command === "check_codex_runtime_update") return pending.promise;
      if (command === "get_codex_install_recovery") return [];
      if (command === "uninstall_codex_runtime") installed = false;
      return {
        supported: true,
        installed,
        version: installed ? "1.2.0" : null,
        running: false,
        canUninstall: installed,
        installMode: "standard",
      };
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "更新" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "check_codex_runtime_update",
        expect.anything(),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "安装方式与更新源" }));
    fireEvent.click(screen.getByRole("button", { name: /卸载 Codex/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认继续" }));
    expect(
      await screen.findByRole("heading", { name: "尚未安装 Codex" }),
    ).toBeVisible();
    await act(async () =>
      pending.resolve({
        currentVersion: "1.2.0",
        latestVersion: "1.3.0",
        updateAvailable: true,
        source: "auto",
        installMode: "standard",
        sizeBytes: 123,
      }),
    );
    expect(
      screen.getAllByRole("button", { name: "检查更新" }).length,
    ).toBeGreaterThan(1);
    expect(
      screen.queryByRole("button", { name: "下载并安装 标准安装" }),
    ).not.toBeInTheDocument();
  });
});

describe("Chimera editor model request ownership", () => {
  it.each(["provider-base-url", "provider-api-key"])(
    "invalidates %s and ignores old completion without clearing a newer request",
    async (field) => {
      const old = deferred<FetchedModel[]>();
      const next = deferred<FetchedModel[]>();
      mocks.fetchModels
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(next.promise);
      mount();
      await editAlpha();
      fireEvent.click(fetchButton());
      expect(fetchButton()).toBeDisabled();
      fireEvent.change(document.querySelector('[name="' + field + '"]')!, {
        target: {
          value:
            field === "provider-api-key"
              ? "new-dummy-key"
              : "https://new.example/v1",
        },
      });
      expect(fetchButton()).toBeEnabled();
      fireEvent.click(fetchButton());
      await act(async () => {
        old.resolve([{ id: "stale-model", ownedBy: null }]);
      });
      expect(fetchButton()).toBeDisabled();
      expect(screen.queryByText("stale-model")).not.toBeInTheDocument();
      await act(async () => {
        next.resolve([]);
      });
      expect(fetchButton()).toBeEnabled();
      expect(mocks.fetchModels).toHaveBeenCalledTimes(2);
    },
  );

  it("releases busy state on close/reopen and suppresses an obsolete rejection", async () => {
    const old = deferred<FetchedModel[]>();
    const next = deferred<FetchedModel[]>();
    mocks.fetchModels
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(next.promise);
    mount();
    await editAlpha();
    fireEvent.click(fetchButton());
    fireEvent.click(screen.getByRole("button", { name: "返回线路" }));
    await editAlpha();
    expect(fetchButton()).toBeEnabled();
    fireEvent.click(fetchButton());
    await act(async () => {
      old.reject(new Error("obsolete-secret"));
    });
    expect(fetchButton()).toBeDisabled();
    expect(mocks.toast.error).not.toHaveBeenCalledWith(
      "获取模型失败，可手动输入模型名称",
      expect.anything(),
    );
    await act(async () => {
      next.resolve([]);
    });
    expect(fetchButton()).toBeEnabled();
  });
});

describe("Chimera tray/profile subscription", () => {
  it("reads backend selection, ignores other apps, and permits switching back to the old line", async () => {
    mount();
    await screen.findByRole("button", { name: /^Alpha，.*当前线路/ });
    const count = mocks.getAll.mock.calls.length;
    emit("claude", "Beta");
    expect(mocks.getAll).toHaveBeenCalledTimes(count);
    mocks.getCurrent.mockResolvedValue("Beta");
    emit();
    await screen.findByRole("button", { name: /^Beta，.*当前线路/ });
    fireEvent.click(screen.getByRole("button", { name: /^Alpha，/ }));
    await waitFor(() =>
      expect(mocks.switchProvider).toHaveBeenCalledWith("Alpha", "codex"),
    );
  });

  it("rejects late profile snapshots and keeps one live listener under StrictMode", async () => {
    const { unmount } = mount(true);
    await screen.findByRole("button", { name: /^Alpha，.*当前线路/ });
    expect(handlers.get("provider-switched")?.size).toBe(1);
    const old = deferred<Record<string, Provider>>();
    mocks.getAll.mockReturnValueOnce(old.promise);
    emit();
    mocks.getAll.mockResolvedValue({ Gamma: provider("Gamma") });
    mocks.getCurrent.mockResolvedValue("Gamma");
    emit();
    await screen.findByRole("button", { name: /^Gamma，.*当前线路/ });
    await act(async () => {
      old.resolve({ Alpha: provider("Alpha") });
    });
    expect(
      screen.getByRole("button", { name: /^Gamma，.*当前线路/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Alpha，/ }),
    ).not.toBeInTheDocument();
    unmount();
    expect(handlers.get("provider-switched")?.size).toBe(0);
  });

  it("ignores live settings from an older profile after newer providers have loaded", async () => {
    mount();
    await screen.findByRole("button", { name: /^Alpha，.*当前线路/ });
    const oldLive = deferred<unknown>();
    mocks.getLive.mockReturnValueOnce(oldLive.promise);
    const previousReads = mocks.getLive.mock.calls.length;
    emit();
    await waitFor(() =>
      expect(mocks.getLive).toHaveBeenCalledTimes(previousReads + 1),
    );
    mocks.getAll.mockResolvedValue({ Gamma: provider("Gamma") });
    mocks.getCurrent.mockResolvedValue("Gamma");
    emit();
    await screen.findByRole("button", { name: /^Gamma，.*当前线路/ });
    await act(async () => {
      oldLive.resolve(provider("Alpha").settingsConfig);
    });
    expect(
      screen.getByRole("button", { name: /^Gamma，.*当前线路/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Alpha，/ }),
    ).not.toBeInTheDocument();
  });

  it("disposes a listener that finishes registering after unmount", async () => {
    const registration = deferred<() => void>();
    const dispose = vi.fn();
    const normal = mocks.listen.getMockImplementation()!;
    let callback: ((event: { payload: unknown }) => void) | undefined;
    mocks.listen.mockImplementation((event, handler) => {
      if (event !== "provider-switched") return normal(event, handler);
      callback = handler;
      return registration.promise;
    });
    const { unmount } = mount();
    unmount();
    await act(async () => {
      registration.resolve(dispose);
    });
    callback?.({ payload: { appType: "codex", providerId: "Beta" } });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(mocks.getAll).not.toHaveBeenCalled();
  });
});

describe("cold-start import through the real App and Chimera", () => {
  it("consumes duplicate notifications once and refreshes its own provider state from the backend", async () => {
    let pending: unknown = {
      id: "cold-start",
      request: {
        version: "v1",
        resource: "provider",
        app: "codex",
        name: "Imported Route",
        endpoint: "https://imported.example/v1",
        apiKey: "test-import-key",
      },
    };
    const normal = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, payload) => {
      if (command === "get_pending_deeplink") return pending;
      if (command === "dismiss_pending_deeplink") {
        pending = null;
        return;
      }
      if (command === "import_from_deeplink_unified") {
        mocks.getAll.mockResolvedValue({
          Beta: provider("Beta"),
          Imported: provider("Imported"),
        });
        // The event/request name is not the current selection: reread it.
        mocks.getCurrent.mockResolvedValue("Beta");
        return { type: "provider", id: "Imported" };
      }
      return normal(command, payload);
    });
    mount(true, <App />);
    await screen.findByRole("dialog");
    expect(screen.getByText("deeplink.warning")).toBeInTheDocument();
    expect(
      mocks.invoke.mock.calls.filter(
        ([cmd]) => cmd === "import_from_deeplink_unified",
      ),
    ).toHaveLength(0);
    act(() =>
      handlers
        .get("deeplink-import")
        ?.forEach((handler) => handler({ payload: null })),
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "deeplink.import" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await screen.findByRole("button", { name: /^Beta，.*当前线路/ });
    expect(
      screen.getByRole("button", { name: /^Imported，/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Alpha，/ }),
    ).not.toBeInTheDocument();
    act(() =>
      handlers
        .get("deeplink-import")
        ?.forEach((handler) => handler({ payload: null })),
    );
    await act(async () => {});
    expect(
      mocks.invoke.mock.calls.filter(
        ([cmd]) => cmd === "import_from_deeplink_unified",
      ),
    ).toHaveLength(1);
    expect(pending).toBeNull();
  });
});
