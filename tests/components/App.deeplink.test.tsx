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
import type { DeepLinkImportRequest } from "@/lib/api/deeplink";

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
const handlers = new Map<string, Set<() => void>>();
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

beforeEach(() => {
  handlers.clear();
  queue = [{ id: "first", request: request("Cold Start") }];
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
        throw new Error("Unexpected command: " + command);
      },
    );
  mocks.listen
    .mockReset()
    .mockImplementation(async (name: string, handler: () => void) => {
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
    fireEvent.click(importButton());
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(calls("import_from_deeplink_unified")).toHaveLength(1);
    expect(screen.getByTestId("provider-refresh")).toHaveTextContent("1");
    expect(queue).toHaveLength(0);
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
    expect(importButton()).toBeEnabled();
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
