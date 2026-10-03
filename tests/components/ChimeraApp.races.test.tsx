import { StrictMode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
    getResolution: vi.fn(),
    switchProvider: vi.fn(),
    fetchModels: vi.fn(),
    testEndpoints: vi.fn(),
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
      getCodexCurrentResolution: mocks.getResolution,
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
    get: async () => ({
      visibleApps: {
        codex: true,
        claude: true,
        "claude-desktop": true,
        gemini: true,
        grokbuild: true,
        opencode: true,
        openclaw: true,
        hermes: true,
        pi: true,
        mcode: true,
      },
    }),
  },
}));
vi.mock("@/lib/api", () => ({
  configApi: { getCommonConfigSnippet: async () => "" },
}));
vi.mock("@/lib/api/vscode", () => ({
  vscodeApi: {
    testApiEndpoints: mocks.testEndpoints,
  },
}));
vi.mock("@/lib/query/queries", () => ({
  useSettingsQuery: () => ({ data: {} }),
}));
vi.mock("@/contexts/UpdateContext", () => ({ useUpdate: () => ({}) }));
vi.mock("@/components/WindowControls", () => ({ WindowControls: () => null }));
vi.mock("@/components/RouteGlobe", () => ({ default: () => null }));
vi.mock("@/components/settings/AboutSection", () => ({
  AboutSection: () => null,
}));
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
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "管理线路" })).getByRole(
      "button",
      { name: "编辑Alpha" },
    ),
  );
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
  // The backend resolves the current line; with no live config it reports
  // the stored selection.
  mocks.getResolution.mockReset().mockImplementation(async () => ({
    id: await mocks.getCurrent("codex"),
    source: "stored",
  }));
  mocks.fetchModels.mockReset();
  mocks.testEndpoints.mockReset().mockResolvedValue([{ latency: null }]);
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

it("opens the saved-line manager and restores trigger focus on Escape", async () => {
  mount();
  const managerTrigger = await screen.findByRole("button", {
    name: "管理线路",
  });
  fireEvent.click(managerTrigger);
  expect(screen.getByRole("dialog", { name: "管理线路" })).toBeVisible();
  expect(screen.getByRole("textbox", { name: "搜索线路" })).toBeVisible();
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "管理线路" }),
    ).not.toBeInTheDocument(),
  );
  expect(managerTrigger).toHaveFocus();
});

it("exposes maintenance as a modal and restores keyboard focus after Escape", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Codex 管理" }));
  const trigger = screen.getByRole("button", { name: "安装方式与更新源" });
  await waitFor(() => expect(trigger).toBeEnabled());
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "安装与维护" });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "关闭安装与维护" }),
    ).toHaveFocus(),
  );
  fireEvent.keyDown(document, { key: "Escape" });
  expect(
    screen.queryByRole("dialog", { name: "安装与维护" }),
  ).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

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
    fireEvent.click(await screen.findByRole("button", { name: "Codex 管理" }));
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

  it("ignores a current-line resolution from an older profile after newer providers have loaded", async () => {
    mount();
    await screen.findByRole("button", { name: /^Alpha，.*当前线路/ });
    const oldResolution = deferred<{ id: string | null; source: string }>();
    mocks.getResolution.mockReturnValueOnce(oldResolution.promise);
    const previousReads = mocks.getResolution.mock.calls.length;
    emit();
    await waitFor(() =>
      expect(mocks.getResolution).toHaveBeenCalledTimes(previousReads + 1),
    );
    mocks.getAll.mockResolvedValue({ Gamma: provider("Gamma") });
    mocks.getCurrent.mockResolvedValue("Gamma");
    emit();
    await screen.findByRole("button", { name: /^Gamma，.*当前线路/ });
    await act(async () => {
      oldResolution.resolve({ id: "Alpha", source: "live" });
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
      if (command === "preview_deeplink_import") {
        return {
          targetPaths: ["C:\\Users\\test\\.codex\\config.toml"],
          writesLive: true,
          content: "",
          env: [],
        };
      }
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

describe("release capability navigation", () => {
  const assertGatedNavigationDisabled = () => {
    for (const name of [
      "官方账号",
      "提示词",
      "Skills 与 MCP",
      "配置体检",
      "Claude Code",
      "Gemini CLI",
      "OpenCode",
      "Pi",
    ]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
  };

  it("keeps new routes closed while policy is loading and after failure", async () => {
    let rejectPolicy!: (error: Error) => void;
    const pending = new Promise((_, reject) => {
      rejectPolicy = reject;
    });
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "get_product_capabilities"
        ? pending
        : { supported: true, installed: false, running: false },
    );
    mount();
    await waitFor(assertGatedNavigationDisabled);
    await act(async () => {
      rejectPolicy(new Error("policy unavailable"));
    });
    assertGatedNavigationDisabled();
    expect(screen.getByRole("button", { name: "Codex 管理" })).toBeVisible();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.queryByText("官方账号管理")).not.toBeInTheDocument();
    expect(screen.queryByText("打开配置体检")).not.toBeInTheDocument();
  });

  it("enables only routes explicitly enabled by the backend", async () => {
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "get_product_capabilities"
        ? {
            capabilities: [
              { id: "prompts", available: true, enabledByDefault: true },
              {
                id: "official_accounts",
                available: true,
                enabledByDefault: false,
              },
              { id: "config_health", available: false, enabledByDefault: true },
            ],
          }
        : { supported: true, installed: false, running: false },
    );
    mount();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "提示词" })).toBeEnabled(),
    );
    expect(screen.getByRole("button", { name: "官方账号" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "配置体检" })).toBeDisabled();
  });

  it("does not open the fixture importer from a custom browser event", async () => {
    mount();
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("chimera-open-deeplink", {
          detail: { type: "siliconflow" },
        }),
      );
    });
    expect(
      screen.queryByText("SiliconFlow · DeepSeek V3"),
    ).not.toBeInTheDocument();
    expect(
      mocks.invoke.mock.calls.some(
        ([command]) => command === "import_from_deeplink_unified",
      ),
    ).toBe(false);
  });
});

describe("provider switch receipt", () => {
  it("does not issue a success receipt when switching fails", async () => {
    mocks.switchProvider.mockRejectedValueOnce(new Error("switch rejected"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /^Beta，/ }));
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(
        "切换失败",
        expect.anything(),
      ),
    );
    expect(screen.queryByText(/刚刚 从/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "切回" })).toBeDisabled();
  });
});

describe("mini signboard current-line ownership", () => {
  it("shows the mini signboard only away from the full line overview", async () => {
    mount();
    await screen.findByRole("button", { name: /^Alpha，/ });
    expect(
      screen.queryByRole("button", { name: /^当前线路：/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(
      await screen.findByRole("button", { name: /^当前线路：Alpha/ }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /^当前线路：Alpha/ }));
    expect(
      screen.queryByRole("button", { name: /^当前线路：/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: "线路切换" })).toBeVisible();
  });
  it.each([
    { id: "Alpha", source: "none", label: "未选择线路" },
    { id: "Alpha", source: "external", label: "外部配置" },
    { id: "missing", source: "stored", label: "未选择线路" },
  ])(
    "does not mark the first line current for $source/$id",
    async ({ id, source, label }) => {
      mocks.getResolution.mockResolvedValue({ id, source });
      mount();
      await screen.findByRole("button", { name: /^Alpha，/ });
      expect(
        screen.queryByRole("button", { name: /^Alpha，.*当前线路/ }),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "设置" }));
      expect(
        screen.getByRole("button", { name: `当前线路：${label}` }),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: /^当前线路：Alpha/ }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /^Alpha，.*当前线路/ }),
      ).not.toBeInTheDocument();
      expect(mocks.testEndpoints).not.toHaveBeenCalled();
    },
  );

  it("uses the resolved line even when it is not first", async () => {
    mocks.getCurrent.mockResolvedValue("Beta");
    mount();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(
      await screen.findByRole("button", { name: /^当前线路：Beta/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /^当前线路：Alpha/ }),
    ).not.toBeInTheDocument();
  });

  it("discards an old endpoint result after the current line changes", async () => {
    const old = deferred<{ latency: number }[]>();
    mocks.testEndpoints.mockReturnValueOnce(old.promise);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() => expect(mocks.testEndpoints).toHaveBeenCalledTimes(1));
    mocks.getCurrent.mockResolvedValue("Beta");
    emit("codex", "Beta");
    await screen.findByRole("button", { name: "当前线路：Beta，未测速" });
    await act(async () => old.resolve([{ latency: 182 }]));
    expect(
      screen.getByRole("button", { name: "当前线路：Beta，未测速" }),
    ).toBeVisible();
    expect(screen.queryByText("182 ms")).not.toBeInTheDocument();
  });

  it("clears a measured result when the same line endpoint changes", async () => {
    mocks.testEndpoints.mockResolvedValueOnce([{ latency: 182 }]);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await screen.findByRole("button", { name: "当前线路：Alpha，182 ms" });
    const updated = provider("Alpha");
    updated.settingsConfig.config = String(
      updated.settingsConfig.config,
    ).replace("example.com", "new.example.com");
    mocks.getAll.mockResolvedValue({ Alpha: updated, Beta: provider("Beta") });
    emit();
    expect(
      await screen.findByRole("button", { name: "当前线路：Alpha，未测速" }),
    ).toBeVisible();
  });
});

describe("native tool editor ownership", () => {
  const cases = [
    [
      "claude",
      "Claude Code",
      {
        env: {
          ANTHROPIC_BASE_URL: "https://old.example",
          ANTHROPIC_AUTH_TOKEN: "old-key",
          ANTHROPIC_MODEL: "old-model",
        },
        permissions: { allow: ["Read"] },
      },
    ],
    [
      "gemini",
      "Gemini CLI",
      {
        env: {
          GOOGLE_GEMINI_BASE_URL: "https://old.example",
          GEMINI_API_KEY: "old-key",
          GEMINI_MODEL: "old-model",
        },
        config: { theme: "Default" },
      },
    ],
    [
      "opencode",
      "OpenCode",
      {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://old.example", apiKey: "old-key" },
        models: { "old-model": {}, second: { name: "Preserved" } },
      },
    ],
    [
      "pi",
      "Pi",
      {
        baseUrl: "https://old.example",
        apiKey: "old-key",
        api: "openai-completions",
        models: [{ id: "old-model" }, { id: "second" }],
      },
    ],
  ] as const;

  function enableTools() {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "get_product_capabilities")
        return {
          capabilities: [
            { id: "multi_tool", available: true, enabledByDefault: true },
          ],
        };
      if (
        [
          "add_and_activate_provider",
          "update_and_activate_provider",
          "delete_provider",
        ].includes(command)
      )
        return true;
      return { supported: true, installed: false, running: false };
    });
  }

  async function openTool(label: string) {
    const navigation = await screen.findByRole("button", {
      name: label,
    });
    await waitFor(() => expect(navigation).toBeEnabled());
    fireEvent.click(navigation);
    // ToolView is lazy-loaded; module transformation under CI/build load can
    // exceed Testing Library's 1s default before the page itself has mounted.
    await screen.findByRole(
      "heading",
      { name: label, level: 1 },
      { timeout: 5000 },
    );
  }

  function fillField(name: string, value: string) {
    fireEvent.change(document.querySelector('[name="' + name + '"]')!, {
      target: { value },
    });
  }

  it.each([
    ["claude", "Claude Code"],
    ["gemini", "Gemini CLI"],
    ["opencode", "OpenCode"],
  ])(
    "opens Skills/MCP with the target selected from the %s page",
    async (appId, label) => {
      enableTools();
      const original = mocks.invoke.getMockImplementation()!;
      mocks.invoke.mockImplementation(async (command: string) => {
        if (command === "get_product_capabilities")
          return {
            capabilities: ["multi_tool", "skills", "mcp"].map((id) => ({
              id,
              available: true,
              enabledByDefault: true,
            })),
          };
        if (command === "get_installed_skills") return [];
        if (command === "get_mcp_servers" || command === "get_notes") return {};
        return original(command);
      });
      mount();
      await openTool(label);
      fireEvent.click(
        screen.getByRole("button", { name: `管理 ${label} 的 Skills 与 MCP` }),
      );
      expect(
        await screen.findByRole("combobox", { name: "目标工具" }),
      ).toHaveValue(appId);
      expect(await screen.findByText("暂无已安装的 Skills")).toBeVisible();
    },
  );

  it.each(cases)(
    "adds a %s line through its native schema",
    async (appId, label) => {
      enableTools();
      mount();
      await openTool(label);
      fireEvent.click(screen.getByRole("button", { name: "添加线路" }));
      await screen.findByRole("region", { name: "新建线路" });
      expect(screen.queryByText("Codex 功能")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "获取模型" }),
      ).not.toBeInTheDocument();
      fillField("provider-name", "Native");
      fillField("provider-base-url", "https://new.example/custom");
      fillField("provider-api-key", "new-key");
      fillField("provider-model", "new-model");
      fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));
      await waitFor(() =>
        expect(mocks.invoke).toHaveBeenCalledWith(
          "add_and_activate_provider",
          expect.objectContaining({ app: appId }),
        ),
      );
      const payload = mocks.invoke.mock.calls.find(
        ([cmd]) => cmd === "add_and_activate_provider",
      )![1].provider;
      expect(payload.settingsConfig).not.toHaveProperty("auth");
      expect(payload.settingsConfig).not.toHaveProperty("modelCatalog");
      const { toolProviderFields } = await import("@/utils/toolProviderConfig");
      expect(toolProviderFields(appId, payload)).toMatchObject({
        baseUrl: "https://new.example/custom",
        apiKey: "new-key",
        model: "new-model",
      });
      expect(mocks.fetchModels).not.toHaveBeenCalled();
      expect(screen.queryByText("立即重启 Codex")).not.toBeInTheDocument();
      await waitFor(() =>
        expect(
          screen.queryByRole("region", { name: "新建线路" }),
        ).not.toBeInTheDocument(),
      );
    },
  );

  it.each(cases)(
    "reads and updates %s native fields from the real tool route",
    async (appId, label, settingsConfig) => {
      enableTools();
      const native = { id: "native", name: "Native", settingsConfig };
      mocks.getAll.mockImplementation(async (app: string) =>
        app === "codex"
          ? { Alpha: provider("Alpha"), Beta: provider("Beta") }
          : { native },
      );
      mount();
      await openTool(label);
      fireEvent.click(
        await screen.findByRole("button", { name: "编辑Native" }),
      );
      await screen.findByRole("region", { name: "编辑线路" });
      expect(document.querySelector('[name="provider-base-url"]')).toHaveValue(
        "https://old.example",
      );
      expect(document.querySelector('[name="provider-api-key"]')).toHaveValue(
        "old-key",
      );
      expect(document.querySelector('[name="provider-model"]')).toHaveValue(
        "old-model",
      );
      fillField("provider-base-url", "https://changed.example");
      fillField("provider-api-key", "changed-key");
      fillField("provider-model", "changed-model");
      fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));
      await waitFor(() =>
        expect(mocks.invoke).toHaveBeenCalledWith(
          "update_and_activate_provider",
          expect.objectContaining({ app: appId, originalId: "native" }),
        ),
      );
      const payload = mocks.invoke.mock.calls.find(
        ([cmd]) => cmd === "update_and_activate_provider",
      )![1].provider;
      const { toolProviderFields } = await import("@/utils/toolProviderConfig");
      expect(toolProviderFields(appId, payload)).toMatchObject({
        baseUrl: "https://changed.example",
        apiKey: "changed-key",
        model: "changed-model",
      });
      if (appId === "gemini")
        expect(payload.settingsConfig.config).toEqual({ theme: "Default" });
      if (appId === "claude")
        expect(payload.settingsConfig.permissions).toEqual({ allow: ["Read"] });
      if (appId === "opencode")
        expect(payload.settingsConfig.models.second).toEqual({
          name: "Preserved",
        });
      if (appId === "pi")
        expect(payload.settingsConfig.models[1]).toEqual({ id: "second" });
      await waitFor(() =>
        expect(
          screen.queryByRole("region", { name: "编辑线路" }),
        ).not.toBeInTheDocument(),
      );
    },
  );

  async function beginDelayedOpen(
    label: string,
    settingsConfig: Provider["settingsConfig"],
  ) {
    enableTools();
    const native = { id: "native", name: "Native", settingsConfig };
    mocks.getAll.mockImplementation(async (app: string) =>
      app === "codex"
        ? { Alpha: provider("Alpha"), Beta: provider("Beta") }
        : { native },
    );
    const mounted = mount();
    await openTool(label);
    const button = await screen.findByRole("button", { name: "编辑Native" });
    const pending = deferred<Record<string, Provider>>();
    mocks.getAll.mockImplementationOnce(() => pending.promise);
    fireEvent.click(button);
    expect(
      screen.queryByRole("region", { name: "编辑线路" }),
    ).not.toBeInTheDocument();
    return { pending, native, mounted };
  }

  it.each(cases)(
    "does not overwrite a new unsaved %s draft when an old open resolves",
    async (_appId, label, config) => {
      const { pending, native } = await beginDelayedOpen(label, config);
      fireEvent.click(screen.getByRole("button", { name: "添加线路" }));
      await screen.findByRole("region", { name: "新建线路" });
      fillField("provider-name", "Unsaved new draft");
      fillField("provider-base-url", "https://unsaved.example");
      await act(async () => {
        pending.resolve({ native });
        await pending.promise;
      });
      expect(screen.getByRole("region", { name: "新建线路" })).toBeVisible();
      expect(document.querySelector('[name="provider-name"]')).toHaveValue(
        "Unsaved new draft",
      );
      expect(document.querySelector('[name="provider-base-url"]')).toHaveValue(
        "https://unsaved.example",
      );
      // The delayed response must not reset the dirty baseline either.
      fireEvent.click(screen.getByRole("button", { name: "返回线路" }));
      expect(screen.getByRole("region", { name: "新建线路" })).toBeVisible();
    },
  );

  it.each(cases)(
    "does not reopen an old %s line after a new editor is closed",
    async (_appId, label, config) => {
      const { pending, native } = await beginDelayedOpen(label, config);
      fireEvent.click(screen.getByRole("button", { name: "添加线路" }));
      await screen.findByRole("region", { name: "新建线路" });
      fireEvent.click(screen.getByRole("button", { name: "返回线路" }));
      expect(
        screen.queryByRole("region", { name: "新建线路" }),
      ).not.toBeInTheDocument();
      await act(async () => {
        pending.resolve({ native });
        await pending.promise;
      });
      expect(
        screen.queryByRole("region", { name: "编辑线路" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: label, level: 1 }),
      ).toBeVisible();
    },
  );

  it.each(cases)(
    "revokes a pending %s open even after navigating away and back",
    async (_appId, label, config) => {
      const { pending, native } = await beginDelayedOpen(label, config);
      await openTool(label === "Claude Code" ? "Gemini CLI" : "Claude Code");
      await openTool(label);
      await screen.findByRole("button", { name: "编辑Native" });
      await act(async () => {
        pending.resolve({ native });
        await pending.promise;
      });
      expect(
        screen.queryByRole("region", { name: "编辑线路" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: label, level: 1 }),
      ).toBeVisible();
    },
  );

  it("only lets the latest open request own the editor", async () => {
    const { pending, native } = await beginDelayedOpen(
      "Claude Code",
      cases[0][2],
    );
    const latest = deferred<Record<string, Provider>>();
    mocks.getAll.mockImplementationOnce(() => latest.promise);
    fireEvent.click(screen.getByRole("button", { name: "编辑Native" }));
    await act(async () => {
      latest.resolve({ native: { ...native, name: "Latest" } });
      await latest.promise;
    });
    await screen.findByRole("region", { name: "编辑线路" });
    fillField("provider-name", "Latest unsaved");
    await act(async () => {
      pending.resolve({ native });
      await pending.promise;
    });
    expect(document.querySelector('[name="provider-name"]')).toHaveValue(
      "Latest unsaved",
    );
  });

  it("silences a stale open failure after navigating away", async () => {
    const { pending } = await beginDelayedOpen("Claude Code", cases[0][2]);
    await openTool("Gemini CLI");
    mocks.toast.error.mockClear();
    await act(async () => {
      pending.reject(new Error("old read failed"));
      await pending.promise.catch(() => {});
    });
    expect(mocks.toast.error).not.toHaveBeenCalledWith(
      "无法打开线路",
      expect.anything(),
    );
    expect(
      screen.getByRole("heading", { name: "Gemini CLI", level: 1 }),
    ).toBeVisible();
  });

  it("revokes a pending open on unmount", async () => {
    const { pending, mounted } = await beginDelayedOpen(
      "Claude Code",
      cases[0][2],
    );
    mounted.unmount();
    mocks.toast.error.mockClear();
    await act(async () => {
      pending.reject(new Error("unmounted read"));
      await pending.promise.catch(() => {});
    });
    expect(mocks.toast.error).not.toHaveBeenCalledWith(
      "无法打开线路",
      expect.anything(),
    );
  });

  it("keeps Codex list deletion scoped to Codex after closing a Claude editor", async () => {
    enableTools();
    mount();
    await openTool("Claude Code");
    fireEvent.click(screen.getByRole("button", { name: "添加线路" }));
    await screen.findByRole("region", { name: "新建线路" });
    fireEvent.click(screen.getByRole("button", { name: "返回线路" }));
    fireEvent.click(screen.getByRole("button", { name: "线路" }));
    fireEvent.click(await screen.findByRole("button", { name: "管理线路" }));
    const manager = screen.getByRole("dialog", { name: "管理线路" });
    fireEvent.click(within(manager).getByRole("button", { name: "删除Beta" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("delete_provider", {
        app: "codex",
        id: "Beta",
      }),
    );
    expect(mocks.invoke).not.toHaveBeenCalledWith("delete_provider", {
      app: "claude",
      id: "Beta",
    });
  });
});
