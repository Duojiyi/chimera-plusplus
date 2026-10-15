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
import type {
  DeepLinkImportPreview,
  DeepLinkImportRequest,
} from "@/lib/api/deeplink";

const mocks = vi.hoisted(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
  return {
    invoke: vi.fn(),
    listen: vi.fn(),
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/ChimeraApp", () => ({
  default: ({ providerRefreshVersion }: { providerRefreshVersion: number }) => (
    <output data-testid="provider-refresh">{providerRefreshVersion}</output>
  ),
}));
import App from "@/App";

// Load the real confirmation UI before test timers begin. App still reaches it
// through React.lazy; icon/module transformation time is not a behavior timeout.
beforeAll(async () => {
  await import("@/components/DeepLinkImportDialog");
}, 30000);

type Pending = { id: string; request: DeepLinkImportRequest };
const request = (name: string): DeepLinkImportRequest => ({
  version: "v1",
  resource: "provider",
  app: "codex",
  name,
  endpoint: "http://127.0.0.1:8080/v1",
  apiKey: "fake-secret-do-not-display",
});
let queue: Pending[];
let preview: DeepLinkImportPreview;
type EventHandler = (event?: { payload: unknown }) => void;
const handlers = new Map<string, Set<EventHandler>>();
const notify = () =>
  act(() => {
    handlers.get("deeplink-import")?.forEach((handler) => handler());
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function mount(strict = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const app = (
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  );
  return render(strict ? <StrictMode>{app}</StrictMode> : app);
}
const calls = (command: string) =>
  mocks.invoke.mock.calls.filter(([name]) => name === command);
const importButton = () =>
  screen.getByRole("button", { name: "deeplink.import" });

// The import button stays disabled until the backend preview has loaded.
const importReady = () => waitFor(() => expect(importButton()).toBeEnabled());

beforeEach(() => {
  handlers.clear();
  queue = [{ id: "first", request: request("Cold Start") }];
  preview = {
    targetPaths: ["/home/test/.codex/config.toml"],
    writesLive: false,
    content: "{}",
    env: [],
  };
  mocks.invoke
    .mockReset()
    .mockImplementation(
      async (
        command: string,
        payload?: { id?: string; request?: DeepLinkImportRequest },
      ) => {
        if (command === "get_pending_deeplink") return queue[0] ?? null;
        if (command === "dismiss_pending_deeplink") {
          queue = queue.filter((pending) => pending.id !== payload?.id);
          return;
        }
        if (command === "import_from_deeplink_unified")
          return { type: "provider", id: "provider-new" };
        if (command === "merge_deeplink_config") return payload?.request;
        if (command === "preview_deeplink_import") return preview;
        throw new Error("Unexpected command: " + command);
      },
    );
  mocks.listen
    .mockReset()
    .mockImplementation(async (name: string, handler: EventHandler) => {
      const set = handlers.get(name) ?? new Set();
      handlers.set(name, set);
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    });
});
afterEach(cleanup);

describe("default App deep-link handoff", () => {
  it("reads a cold-start pending request after subscribing and preserves explicit risk confirmation", async () => {
    mount(true);
    await screen.findByText("Cold Start");
    expect(screen.getByText("deeplink.warning")).toBeInTheDocument();
    expect(screen.getByText(/deeplink.risk/)).toBeInTheDocument();
    expect(
      screen.queryByText("fake-secret-do-not-display"),
    ).not.toBeInTheDocument();
    expect(calls("import_from_deeplink_unified")).toHaveLength(0);
    expect(handlers.get("deeplink-import")?.size).toBe(1);
    await importReady();
    expect(
      screen.getByText("/home/test/.codex/config.toml"),
    ).toBeInTheDocument();
    fireEvent.click(importButton());
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(calls("import_from_deeplink_unified")).toHaveLength(1);
    expect(screen.getByTestId("provider-refresh")).toHaveTextContent("1");
    expect(queue).toHaveLength(0);
  });

  it.each(["claude", "gemini"] as const)(
    "refreshes the current tool after a %s provider import",
    async (app) => {
      queue[0].request.app = app;
      mount();
      await screen.findByText("Cold Start");
      await importReady();
      fireEvent.click(importButton());
      await waitFor(() =>
        expect(screen.getByTestId("provider-refresh")).toHaveTextContent("1"),
      );
    },
  );

  it("refreshes local-state pages even for a resource import", async () => {
    const normal = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, payload) =>
      command === "import_from_deeplink_unified"
        ? Promise.resolve({
            type: "mcp",
            importedCount: 1,
            importedIds: ["test"],
            failed: [],
          })
        : normal(command, payload),
    );
    mount();
    await screen.findByText("Cold Start");
    await importReady();
    fireEvent.click(importButton());
    await waitFor(() =>
      expect(screen.getByTestId("provider-refresh")).toHaveTextContent("1"),
    );
    expect(calls("import_from_deeplink_unified")).toHaveLength(1);
  });

  it("does not duplicate import when events overlap pending reads or a double click", async () => {
    const importing = deferred<{ type: string; id: string }>();
    const normal = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, payload) =>
      command === "import_from_deeplink_unified"
        ? importing.promise
        : normal(command, payload),
    );
    mount();
    await screen.findByText("Cold Start");
    notify();
    notify();
    await act(async () => {});
    await importReady();
    fireEvent.click(importButton());
    fireEvent.click(screen.getByRole("button", { name: "deeplink.importing" }));
    notify();
    expect(calls("import_from_deeplink_unified")).toHaveLength(1);
    await act(async () => {
      importing.resolve({ type: "provider", id: "new" });
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    notify();
    await act(async () => {});
    expect(calls("import_from_deeplink_unified")).toHaveLength(1);
  });

  it("keeps the active confirmation and advances the queue only after cancellation", async () => {
    const merging = deferred<DeepLinkImportRequest>();
    queue[0].request.configUrl = "https://example.com/config";
    const normal = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, payload) =>
      command === "merge_deeplink_config"
        ? merging.promise
        : normal(command, payload),
    );
    mount();
    await screen.findByText("Cold Start");
    expect(importButton()).toBeDisabled();
    queue.push({ id: "second", request: request("Second Request") });
    notify();
    expect(screen.queryByText("Second Request")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    await screen.findByText("Second Request");
    await act(async () => {
      merging.resolve({ ...request("Obsolete Merge"), config: "e30=" });
    });
    expect(screen.queryByText("Obsolete Merge")).not.toBeInTheDocument();
    expect(calls("import_from_deeplink_unified")).toHaveLength(0);
    await importReady();
  });

  it("blocks unreviewed remote config after a merge error", async () => {
    queue[0].request.configUrl = "https://example.com/config";
    const normal = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, payload) =>
      command === "merge_deeplink_config"
        ? Promise.reject(new Error("offline"))
        : normal(command, payload),
    );
    mount();
    await screen.findByRole("alert");
    expect(importButton()).toBeDisabled();
    fireEvent.click(importButton());
    expect(calls("import_from_deeplink_unified")).toHaveLength(0);
  });

  it("retries acknowledgement without importing twice when dismissal fails", async () => {
    const normal = mocks.invoke.getMockImplementation()!;
    let failAck = true;
    mocks.invoke.mockImplementation((command, payload) => {
      if (command === "dismiss_pending_deeplink" && failAck) {
        failAck = false;
        return Promise.reject(new Error("IPC unavailable"));
      }
      return normal(command, payload);
    });
    mount();
    await screen.findByText("Cold Start");
    await importReady();
    fireEvent.click(importButton());
    const done = await screen.findByRole("button", { name: "完成" });
    expect(mocks.toast.error).toHaveBeenCalledWith(
      expect.stringContaining("导入已完成"),
    );
    fireEvent.click(done);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(calls("import_from_deeplink_unified")).toHaveLength(1);
  });

  it("ignores a pre-ack snapshot that resolves after advancing to the next request", async () => {
    const stale = deferred<Pending | null>();
    const first = queue[0];
    mount();
    await screen.findByText("Cold Start");
    queue.push({ id: "second", request: request("Second Request") });
    const normal = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementationOnce(() => stale.promise);
    notify();
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    await screen.findByText("Second Request");
    await act(async () => {
      stale.resolve(first);
    });
    expect(screen.queryByText("Cold Start")).not.toBeInTheDocument();
    expect(screen.getByText("Second Request")).toBeInTheDocument();
    expect(calls("import_from_deeplink_unified")).toHaveLength(0);
    mocks.invoke.mockImplementation(normal);
  });

  it("clears a dismissed dialog even if the next read fails, then recovers on focus", async () => {
    mount();
    await screen.findByText("Cold Start");
    queue.push({ id: "second", request: request("Second Request") });
    const normal = mocks.invoke.getMockImplementation()!;
    let failRead = true;
    mocks.invoke.mockImplementation((command, payload) => {
      if (command === "get_pending_deeplink" && failRead) {
        failRead = false;
        return Promise.reject(new Error("temporary IPC failure"));
      }
      return normal(command, payload);
    });
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(queue[0].id).toBe("second");
    fireEvent.focus(window);
    await screen.findByText("Second Request");
    expect(calls("import_from_deeplink_unified")).toHaveLength(0);
  });

  it("sends only the env keys the user confirmed one by one", async () => {
    queue[0].request = {
      ...request("Env Claude"),
      app: "claude",
      config: btoa(JSON.stringify({ env: { VENDOR_FLAG: "1", PATH: "/x" } })),
      configFormat: "json",
    };
    preview = {
      ...preview,
      env: [
        { key: "VENDOR_FLAG", status: "needsConfirmation" },
        { key: "PATH", status: "denied" },
      ],
    };
    mount();
    await screen.findByText("Env Claude");
    await importReady();
    // Only the unknown key gets a checkbox; the denied key is just flagged.
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    fireEvent.click(importButton());
    await waitFor(() =>
      expect(calls("import_from_deeplink_unified")).toHaveLength(1),
    );
    const [, payload] = calls("import_from_deeplink_unified")[0];
    expect(payload.request.confirmedEnvKeys).toEqual(["VENDOR_FLAG"]);
  });

  it("starts on the safe action and ignores a held Enter", async () => {
    mount();
    await screen.findByText("Cold Start");
    await importReady();
    const cancel = screen.getByRole("button", { name: "common.cancel" });
    expect(cancel).toHaveFocus();
    // A key held down from where the link was pasted must not reach a button.
    expect(fireEvent.keyDown(cancel, { key: "Enter", repeat: true })).toBe(
      false,
    );
    expect(fireEvent.keyDown(cancel, { key: "Enter" })).toBe(true);
    expect(calls("import_from_deeplink_unified")).toHaveLength(0);
  });

  it("shows stored credentials by their last four characters only", async () => {
    queue[0].request.app = "claude";
    preview = {
      ...preview,
      content: JSON.stringify(
        {
          env: {
            ANTHROPIC_AUTH_TOKEN: "fake-secret-do-not-display",
            ANTHROPIC_BASE_URL: "http://127.0.0.1:8080/v1",
          },
        },
        null,
        2,
      ),
    };
    mount();
    await screen.findByText("Cold Start");
    await importReady();
    fireEvent.click(screen.getByText("查看将保存的完整内容"));
    expect(
      screen.getByText(/"ANTHROPIC_AUTH_TOKEN": "••••play"/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/fake-secret-do-not-display/),
    ).not.toBeInTheDocument();
  });

  it("switches lines only after the user turns the switch on", async () => {
    queue[0].request.enabled = true;
    preview = { ...preview, mayActivate: true };
    mount();
    await screen.findByText("Cold Start");
    await importReady();
    const activate = screen.getByRole("switch", {
      name: "导入后立即切换到这条线路",
    });
    // The link asked for it; the switch still starts off.
    expect(activate).toHaveAttribute("aria-checked", "false");
    fireEvent.click(activate);
    fireEvent.click(screen.getByRole("button", { name: "导入并切换" }));
    await waitFor(() =>
      expect(calls("import_from_deeplink_unified")).toHaveLength(1),
    );
    const [, payload] = calls("import_from_deeplink_unified")[0];
    expect(payload.request.enabled).toBe(true);
  });

  it("enables a link's usage script only with explicit consent", async () => {
    queue[0].request.usageEnabled = true;
    preview = {
      ...preview,
      usage: {
        code: "({\n  request: { url: '{{baseUrl}}/usage' }\n})",
        hosts: ["127.0.0.1:8080"],
        linkRequestsEnabled: true,
        autoIntervalMinutes: 30,
      },
    };
    mount();
    await screen.findByText("Cold Start");
    await importReady();
    expect(
      screen.getByRole("region", { name: "用量查询脚本代码" }),
    ).toHaveTextContent("request: { url: '{{baseUrl}}/usage' }");
    const consent = screen.getByRole("switch", {
      name: "导入后启用用量查询",
    });
    expect(consent).toHaveAttribute("aria-checked", "false");
    fireEvent.click(importButton());
    await waitFor(() =>
      expect(calls("import_from_deeplink_unified")).toHaveLength(1),
    );
    const [, payload] = calls("import_from_deeplink_unified")[0];
    expect(payload.request.confirmedUsageEnabled).toBe(false);
    expect(payload.request.enabled).toBe(false);
  });

  it("says where to find a line whose tool is not in the sidebar", async () => {
    queue[0].request.app = "claude";
    const normal = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, payload) =>
      command === "get_settings"
        ? Promise.resolve({ visibleApps: { codex: true, claude: false } })
        : normal(command, payload),
    );
    mount();
    expect(
      await screen.findByText(/Claude Code 目前没有显示在侧栏/),
    ).toBeInTheDocument();
  });

  it("reports an MCP import that the backend refused as a whole", async () => {
    const normal = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, payload) =>
      command === "import_from_deeplink_unified"
        ? Promise.resolve({
            type: "mcp",
            importedCount: 0,
            importedIds: [],
            failed: [{ id: "broken-one", error: "invalid" }],
          })
        : normal(command, payload),
    );
    mount();
    await screen.findByText("Cold Start");
    await importReady();
    fireEvent.click(importButton());
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(
        "MCP 服务器未导入",
        expect.objectContaining({
          description: expect.stringContaining("broken-one"),
        }),
      ),
    );
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.toast.warning).not.toHaveBeenCalled();
  });

  it.each([
    [
      { url: "ccswitch://v1", error: "DEEP_LINK_PARSE_FAILED" },
      "无法识别这个导入链接",
    ],
    [{ error: "DEEP_LINK_QUEUE_FULL" }, "待确认的导入太多"],
    [{ error: "此功能在当前版本未开放: multi_tool" }, "无法导入这个链接"],
    [null, "无法处理导入链接"],
  ])("explains why a link was refused (%j)", async (payload, title) => {
    queue = [];
    mount();
    await waitFor(() => expect(handlers.get("deeplink-error")?.size).toBe(1));
    act(() => {
      handlers
        .get("deeplink-error")
        ?.forEach((handler) => handler({ payload }));
    });
    expect(mocks.toast.error).toHaveBeenCalledWith(
      title,
      expect.objectContaining({ description: expect.any(String) }),
    );
  });

  it("blocks the import when the backend preview fails", async () => {
    const normal = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, payload) =>
      command === "preview_deeplink_import"
        ? Promise.reject(new Error("invalid"))
        : normal(command, payload),
    );
    mount();
    await screen.findByRole("alert");
    expect(importButton()).toBeDisabled();
    fireEvent.click(importButton());
    expect(calls("import_from_deeplink_unified")).toHaveLength(0);
  });

  it("releases delayed subscriptions after unmount without consuming pending requests", async () => {
    const registration = deferred<() => void>();
    const dispose = vi.fn();
    const normal = mocks.listen.getMockImplementation()!;
    mocks.listen.mockImplementation((name, handler) =>
      name === "deeplink-import" ? registration.promise : normal(name, handler),
    );
    const { unmount } = mount();
    unmount();
    await act(async () => {
      registration.resolve(dispose);
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(calls("get_pending_deeplink")).toHaveLength(0);
    expect(queue).toHaveLength(1);
  });
});
