// Characterization of root-level flows that had only text-matching coverage.
// These pin today's behaviour so the ChimeraApp decomposition stays a pure
// refactor; a deliberate behaviour change must update them explicitly.
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types";
import { activityStorageKey } from "@/chimeraUtils";

const mocks = vi.hoisted(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
  return {
    getAll: vi.fn(),
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
      getCodexCurrentResolution: mocks.getResolution,
      switch: mocks.switchProvider,
    },
  };
});
vi.mock("@/lib/api/model-fetch", () => ({
  fetchModelsForConfig: mocks.fetchModels,
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
  vscodeApi: { testApiEndpoints: mocks.testEndpoints },
}));
vi.mock("@/lib/query/queries", () => ({
  useSettingsQuery: () => ({ data: {} }),
}));
vi.mock("@/contexts/UpdateContext", () => ({ useUpdate: () => ({}) }));
vi.mock("@/components/WindowControls", () => ({ WindowControls: () => null }));
import ChimeraApp from "@/ChimeraApp";

function provider(
  id: string,
  overrides: Partial<Provider> = {},
  baseUrl: string | null = "https://example.com/v1",
): Provider {
  return {
    id,
    name: id,
    category: "custom",
    settingsConfig: {
      auth: { OPENAI_API_KEY: "dummy-key" },
      config:
        'model = "gpt-a"\nmodel_provider = "custom"\n[model_providers.custom]\nname = "custom"\n' +
        (baseUrl ? `base_url = "${baseUrl}"\n` : "") +
        'wire_api = "responses"',
    },
    ...overrides,
  };
}

type Handler = (payload: Record<string, unknown> | undefined) => unknown;
const idleProcess = { supported: true, installed: false, running: false };
function routeInvoke(overrides: Record<string, Handler> = {}) {
  mocks.invoke.mockImplementation(
    async (command: string, payload?: Record<string, unknown>) => {
      if (command in overrides) return overrides[command](payload);
      if (command === "get_product_capabilities") return { capabilities: [] };
      if (command === "get_codex_install_recovery") return [];
      return idleProcess;
    },
  );
}
const calls = (command: string) =>
  mocks.invoke.mock.calls
    .filter(([name]) => name === command)
    .map(([, payload]) => payload);

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ChimeraApp />
    </QueryClientProvider>,
  );
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
function fillField(name: string, value: string) {
  fireEvent.change(document.querySelector(`[name="${name}"]`)!, {
    target: { value },
  });
}
const saveButton = () => screen.getByRole("button", { name: "保存并应用" });

beforeEach(() => {
  window.localStorage.clear();
  mocks.getAll
    .mockReset()
    .mockResolvedValue({ Alpha: provider("Alpha"), Beta: provider("Beta") });
  mocks.getResolution
    .mockReset()
    .mockResolvedValue({ id: "Alpha", source: "stored" });
  mocks.switchProvider
    .mockReset()
    .mockResolvedValue({ warnings: [], routingChanged: false });
  mocks.fetchModels.mockReset().mockResolvedValue([]);
  mocks.testEndpoints.mockReset().mockResolvedValue([{ latency: null }]);
  mocks.listen.mockReset().mockResolvedValue(() => {});
  routeInvoke();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("Codex line save path", () => {
  const runningProcess = {
    supported: true,
    installed: true,
    running: true,
    installMode: "standard",
    officialLoginAvailable: true,
  };
  const restarted = {
    wasRunning: true,
    running: true,
    action: "restarted",
    modelUnlockAttempted: false,
    modelUnlockInjected: false,
    modelUnlockModelCount: 0,
  };

  it("offers a confirmed model reload after switching a running Codex to another line", async () => {
    routeInvoke({
      get_codex_process_status: () => runningProcess,
      probe_codex_renderer_unlock: () => ({
        attachable: true,
        injected: true,
        modelCount: 2,
      }),
      restart_codex_for_model_catalog: () => restarted,
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /^Beta，/ }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "重新加载模型列表？",
    });
    expect(mocks.switchProvider).toHaveBeenCalledWith("Beta", "codex");
    expect(dialog).toHaveTextContent("上一条线路的模型");
    expect(dialog).toHaveTextContent("会中断正在进行的任务");
    expect(calls("restart_codex_for_model_catalog")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "稍后重启" }));
    expect(screen.getByRole("button", { name: "重启 Codex" })).toBeEnabled();
    expect(screen.getByText("Codex 运行中 · 线路待重新加载")).toBeVisible();
    expect(calls("restart_codex_for_model_catalog")).toHaveLength(0);
  });

  it("shows a catalog mismatch reported by the running renderer even without a new switch", async () => {
    const error =
      "桌面端模型列表尚未与当前线路同步，请完整重启 Codex 以重新加载模型目录。";
    routeInvoke({
      get_codex_process_status: () => runningProcess,
      probe_codex_renderer_unlock: () => ({
        attachable: true,
        injected: false,
        modelCount: 2,
        error,
      }),
    });
    mount();
    expect(await screen.findByTitle(error)).toBeVisible();
    expect(screen.getByRole("button", { name: "重启 Codex" })).toBeEnabled();
    expect(calls("restart_codex_for_model_catalog")).toHaveLength(0);
  });

  it("updates and activates, verifies the catalog, then restarts Codex on request", async () => {
    mocks.fetchModels.mockResolvedValue([
      { id: "gpt-a", ownedBy: null },
      { id: "gpt-b", ownedBy: null },
    ]);
    routeInvoke({
      get_codex_process_status: () => runningProcess,
      probe_codex_renderer_unlock: () => ({
        attachable: true,
        injected: true,
        modelCount: 2,
      }),
      update_and_activate_provider: () => true,
      verify_codex_model_catalog: () => ({
        valid: true,
        defaultModel: "gpt-a",
        modelCount: 2,
        runtimeVerified: true,
      }),
      restart_codex_for_model_catalog: () => restarted,
    });
    mount();
    await editAlpha();
    fillField("provider-name", "Alpha 2");
    fireEvent.click(saveButton());

    const dialog = await screen.findByRole("alertdialog", {
      name: "重新加载模型列表？",
    });
    expect(within(dialog).getByText(/默认模型“gpt-a”已写入/)).toBeVisible();
    const [update] = calls("update_and_activate_provider") as Array<{
      provider: Provider;
      app: string;
      originalId: string;
      clearApiKey: boolean;
    }>;
    expect(update).toMatchObject({
      app: "codex",
      originalId: "Alpha",
      clearApiKey: false,
    });
    expect(update.provider).toMatchObject({
      id: "Alpha",
      name: "Alpha 2",
      category: "custom",
      meta: { apiFormat: "openai_responses", apiFormatAutoDetected: true },
      settingsConfig: {
        auth: { OPENAI_API_KEY: "dummy-key" },
        modelCatalog: {
          models: [
            { model: "gpt-a", displayName: "gpt-a" },
            { model: "gpt-b", displayName: "gpt-b" },
          ],
        },
        modelMappings: { models: [] },
      },
    });
    expect(String(update.provider.settingsConfig.config)).toContain(
      'wire_api = "responses"',
    );
    expect(calls("verify_codex_model_catalog")).toEqual([
      {
        expectedModel: "gpt-a",
        expectedModels: [
          { model: "gpt-a", displayName: "gpt-a" },
          { model: "gpt-b", displayName: "gpt-b" },
        ],
      },
    ]);
    const order = mocks.invoke.mock.calls.map(([name]) => name);
    expect(order.indexOf("update_and_activate_provider")).toBeLessThan(
      order.indexOf("verify_codex_model_catalog"),
    );
    expect(mocks.toast.success).toHaveBeenCalledWith("线路与模型目录已保存", {
      description: "已写入 2 个模型，重启 Codex 后生效。",
    });
    expect(
      screen.queryByRole("heading", { name: "编辑线路", level: 2 }),
    ).not.toBeInTheDocument();
    // Saving marks the running Codex as needing a restart.
    expect(screen.getByRole("button", { name: "重启 Codex" })).toBeEnabled();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "立即重启 Codex" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("alertdialog", { name: "重新加载模型列表？" }),
      ).not.toBeInTheDocument(),
    );
    expect(calls("restart_codex_for_model_catalog")).toEqual([
      { confirm: true },
    ]);
    expect(mocks.toast.success).toHaveBeenCalledWith(
      "Codex 已重新加载模型列表",
    );
    expect(screen.getByRole("button", { name: "打开 Codex" })).toBeEnabled();
  });

  it("warns when the runtime cannot confirm the catalog and lets the restart wait", async () => {
    // An unreachable /models endpoint must not block the save.
    mocks.fetchModels.mockRejectedValue(new Error("offline"));
    routeInvoke({
      get_codex_process_status: () => runningProcess,
      update_and_activate_provider: () => true,
      verify_codex_model_catalog: () => ({
        valid: true,
        defaultModel: "gpt-a",
        modelCount: 1,
        runtimeVerified: false,
        runtimeMessage: "运行时探针不可用",
      }),
    });
    mount();
    await editAlpha();
    fireEvent.click(saveButton());

    const dialog = await screen.findByRole("alertdialog", {
      name: "重新加载模型列表？",
    });
    expect(mocks.toast.warning).toHaveBeenCalledWith(
      "线路与模型目录已保存，但未能自动验证实际模型列表",
      {
        description:
          "供应商未返回模型列表，已确保默认模型可用。 运行时探针不可用",
      },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "稍后重启" }));
    expect(
      screen.queryByRole("alertdialog", { name: "重新加载模型列表？" }),
    ).not.toBeInTheDocument();
    expect(mocks.toast.info).toHaveBeenCalledWith(
      "请稍后彻底退出并重新打开 Codex",
    );
    expect(calls("restart_codex_for_model_catalog")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "重启 Codex" })).toBeEnabled();
  });

  it("keeps the editor open after a catalog failure and retries as an update", async () => {
    let verifyAttempts = 0;
    routeInvoke({
      update_and_activate_provider: () => true,
      verify_codex_model_catalog: () => {
        verifyAttempts += 1;
        if (verifyAttempts === 1) throw new Error("catalog mismatch");
        return {
          valid: true,
          defaultModel: "gpt-a",
          modelCount: 1,
          runtimeVerified: true,
        };
      },
    });
    mount();
    await editAlpha();
    fireEvent.click(saveButton());

    expect(
      await screen.findByText(/线路已保存并应用，但模型目录未正确应用/),
    ).toBeVisible();
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "线路已保存，但模型目录未正确应用",
      { description: "Error: catalog mismatch" },
    );
    expect(
      screen.getByRole("heading", { name: "编辑线路", level: 2 }),
    ).toBeVisible();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(saveButton()).toBeEnabled());

    fireEvent.click(saveButton());
    expect(
      await screen.findByRole("alertdialog", { name: "重新加载模型列表？" }),
    ).toBeVisible();
    expect(calls("update_and_activate_provider")).toHaveLength(2);
    expect(calls("add_and_activate_provider")).toHaveLength(0);
    // The fetched list from the first attempt is reused for the retry.
    expect(mocks.fetchModels).toHaveBeenCalledTimes(1);
  });
});

describe("opening Codex", () => {
  const confirmText =
    "Codex 正在运行，继续将关闭并重新启动它以应用最新配置，期间的任何未完成操作都会中断。是否继续？";
  function routeRunningCodex(openResult: Record<string, unknown>) {
    routeInvoke({
      get_codex_process_status: () => ({
        supported: true,
        installed: true,
        running: true,
        installMode: "standard",
        officialLoginAvailable: true,
      }),
      probe_codex_renderer_unlock: () => ({
        attachable: true,
        injected: true,
        modelCount: 1,
      }),
      open_codex_runtime: (payload) => {
        if (payload?.confirmRestart !== true)
          throw "CONFIRM_RESTART_REQUIRED: Codex is running";
        return openResult;
      },
    });
  }

  it("asks before restarting a running Codex and retries with confirmation", async () => {
    routeRunningCodex({
      wasRunning: true,
      running: true,
      action: "restarted",
      modelUnlockAttempted: true,
      modelUnlockInjected: false,
      modelUnlockModelCount: 0,
      modelUnlockError: "调试端口未开启",
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    mount();
    const open = await screen.findByRole("button", { name: "打开 Codex" });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);

    await waitFor(() =>
      expect(mocks.toast.success).toHaveBeenCalledWith("Codex 已重启"),
    );
    expect(confirm).toHaveBeenCalledExactlyOnceWith(confirmText);
    expect(calls("open_codex_runtime")).toEqual([
      { confirmRestart: false },
      { confirmRestart: true },
    ]);
    expect(mocks.toast.warning).toHaveBeenCalledWith(
      "模型目录已保存；桌面端模型选择器增强未连接",
      { description: "调试端口未开启" },
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "打开 Codex" })).toBeEnabled(),
    );
  });

  it("leaves Codex running when the restart is declined", async () => {
    routeRunningCodex({ wasRunning: true, running: true, action: "restarted" });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    mount();
    const open = await screen.findByRole("button", { name: "打开 Codex" });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "打开 Codex" })).toBeEnabled(),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calls("open_codex_runtime")).toEqual([{ confirmRestart: false }]);
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalledWith(
      "无法启动 Codex",
      expect.anything(),
    );
  });
});

describe("line editor dialogs", () => {
  it("picks a default model from the fetched list and closes only the picker on Escape", async () => {
    mocks.fetchModels.mockResolvedValue([
      { id: "gpt-a", ownedBy: null },
      { id: "gpt-b", ownedBy: null },
    ]);
    mount();
    await editAlpha();
    fireEvent.click(screen.getByRole("button", { name: "获取模型" }));
    const picker = await screen.findByRole("dialog", { name: "选择默认模型" });
    expect(mocks.toast.success).toHaveBeenCalledWith("已获取 2 个模型", {
      description: "模型列表不代表模型可用性；自动模式将在保存时尝试识别协议。",
    });
    fireEvent.click(within(picker).getByRole("button", { name: "gpt-b" }));
    expect(
      screen.queryByRole("dialog", { name: "选择默认模型" }),
    ).not.toBeInTheDocument();
    expect(document.querySelector('[name="provider-model"]')).toHaveValue(
      "gpt-b",
    );

    fireEvent.click(screen.getByRole("button", { name: "获取模型" }));
    await screen.findByRole("dialog", { name: "选择默认模型" });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "选择默认模型" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("heading", { name: "编辑线路", level: 2 }),
    ).toBeVisible();
    expect(document.querySelector('[name="provider-model"]')).toHaveValue(
      "gpt-b",
    );
  });

  it("asks before discarding unsaved edits", async () => {
    mount();
    await editAlpha();
    fillField("provider-name", "Unsaved name");
    fireEvent.click(screen.getByRole("button", { name: "返回线路" }));
    const confirm = screen.getByRole("alertdialog", {
      name: "放弃未保存的修改？",
    });
    fireEvent.click(within(confirm).getByRole("button", { name: "继续编辑" }));
    expect(
      screen.queryByRole("alertdialog", { name: "放弃未保存的修改？" }),
    ).not.toBeInTheDocument();
    expect(document.querySelector('[name="provider-name"]')).toHaveValue(
      "Unsaved name",
    );

    fireEvent.click(screen.getByRole("button", { name: "返回线路" }));
    fireEvent.click(
      within(
        screen.getByRole("alertdialog", { name: "放弃未保存的修改？" }),
      ).getByRole("button", { name: "放弃修改" }),
    );
    expect(
      screen.queryByRole("heading", { name: "编辑线路", level: 2 }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: "线路切换" })).toBeVisible();
    expect(calls("update_and_activate_provider")).toHaveLength(0);
  });
});

describe("Codex runtime diagnostics", () => {
  it("runs diagnostics from the maintenance drawer and explains each result", async () => {
    routeInvoke({
      diagnose_codex_runtime: () => [
        { name: "installation", result: "pass" },
        { name: "package signature", result: "warn" },
        { name: "launch", result: "fail" },
        { name: "custom probe", result: "warn" },
      ],
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Codex 管理" }));
    const drawerTrigger = screen.getByRole("button", {
      name: "安装方式与更新源",
    });
    await waitFor(() => expect(drawerTrigger).toBeEnabled());
    fireEvent.click(drawerTrigger);
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "安装与维护" })).getByRole(
        "button",
        { name: /^诊断/ },
      ),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Codex 诊断结果",
    });
    expect(
      screen.queryByRole("dialog", { name: "安装与维护" }),
    ).not.toBeInTheDocument();
    const rows = within(dialog)
      .getAllByRole("article")
      .map((row) => row.textContent);
    expect(rows).toEqual([
      "安装状态本项检查已通过。正常",
      "安装包签名免安装版提取后不再携带可独立验证的安装包签名。已在安装前验证",
      "启动检查建议先修复安装后再次诊断。检查失败",
      "custom probe该项目不影响当前基本使用。需要留意",
    ]);
    fireEvent.click(within(dialog).getByRole("button", { name: "完成" }));
    expect(
      screen.queryByRole("dialog", { name: "Codex 诊断结果" }),
    ).not.toBeInTheDocument();
  });
});

describe("first launch without saved lines", () => {
  beforeEach(() => {
    mocks.getAll.mockResolvedValue({});
    mocks.getResolution.mockResolvedValue({ id: null, source: "none" });
  });

  it("lets the user postpone setup and still reach the app", async () => {
    mount();
    expect(
      await screen.findByRole("heading", {
        name: "开始配置你的 Codex",
        level: 1,
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "设置" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "稍后配置" }));
    expect(screen.getByRole("button", { name: "设置" })).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "开始配置你的 Codex", level: 2 }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "开始配置你的 Codex", level: 1 }),
    ).not.toBeInTheDocument();
  });

  it("opens the first-line editor from the setup screen", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "开始配置" }));
    expect(
      await screen.findByRole("region", { name: "新建线路" }),
    ).toBeVisible();
    expect(document.querySelector('[name="provider-name"]')).toHaveValue(
      "默认线路",
    );
  });
});

describe("activity history", () => {
  it("persists operation records per profile and keeps earlier entries", async () => {
    const key = activityStorageKey("profile-a");
    const earlier = {
      id: "earlier",
      timestamp: 1000,
      provider: "Alpha",
      action: "连接测试",
      result: "success",
    };
    window.localStorage.setItem(key, JSON.stringify([earlier]));
    mount();
    await screen.findByRole("button", { name: /^Alpha，.*当前线路/ });
    // Let the profile key resolve before the first new record is written.
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /^Beta，/ }));
    await waitFor(() =>
      expect(mocks.toast.success).toHaveBeenCalledWith("已应用到 Codex", {
        description: undefined,
      }),
    );

    const stored = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    expect(stored[0]).toMatchObject({
      provider: "Beta",
      action: "切换线路",
      result: "success",
      detail: "配置已写入 Codex",
    });
    expect(stored.at(-1)).toEqual(earlier);
    // Never written to a profile-independent key.
    const storedKeys = Array.from(
      { length: window.localStorage.length },
      (_, index) => window.localStorage.key(index),
    );
    expect(storedKeys).toEqual([key]);
  });
});

describe("command palette", () => {
  it("speed-tests every saved line in list order", async () => {
    // Characterizes current behaviour, including the known issues listed in
    // the decomposition plan: each result lands in the active line's banner
    // and a custom line without an address is probed at 127.0.0.1:4000.
    mocks.getAll.mockResolvedValue({
      Alpha: provider("Alpha"),
      Official: provider("Official", { category: "official" }, null),
      Bare: provider("Bare", {}, null),
      Beta: provider("Beta", {}, "https://beta.example/v1"),
    });
    mount();
    await screen.findByRole("button", { name: /^Alpha，.*当前线路/ });
    await waitFor(() => expect(mocks.testEndpoints).toHaveBeenCalledTimes(1));
    mocks.testEndpoints.mockClear();
    mocks.testEndpoints.mockResolvedValue([{ latency: 120 }]);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.click(screen.getByText("测速全部线路"));

    await waitFor(() => expect(mocks.testEndpoints).toHaveBeenCalledTimes(4));
    expect(mocks.toast.info).toHaveBeenCalledWith("正在对所有线路进行测速…");
    expect(mocks.testEndpoints.mock.calls).toEqual([
      [["https://example.com/v1"], { timeoutSecs: 12 }],
      [["https://api.openai.com/v1"], { timeoutSecs: 12 }],
      [["http://127.0.0.1:4000"], { timeoutSecs: 12 }],
      [["https://beta.example/v1"], { timeoutSecs: 12 }],
    ]);
    expect(screen.queryByText("测速全部线路")).not.toBeInTheDocument();
  });
});
