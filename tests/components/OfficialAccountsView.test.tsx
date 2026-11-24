import { StrictMode } from "react";
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
import { OfficialAccountsView } from "@/views/OfficialAccountsView";
import {
  officialAccountsApi,
  type OfficialAccountDto,
} from "@/lib/api/officialAccounts";
const previewMode = vi.hoisted(() => ({ enabled: false, empty: false }));
vi.mock(
  "@/views/OfficialAccountsView.designSamples",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/views/OfficialAccountsView.designSamples")
      >();
    return {
      ...actual,
      isAccountsDesignPreview: () => previewMode.enabled,
      sampleAccounts: (now: number) =>
        previewMode.empty ? [] : actual.sampleAccounts(now),
    };
  },
);
import type { SubscriptionQuota } from "@/types/subscription";
vi.mock("@/lib/api/officialAccounts", () => ({
  officialAccountsApi: {
    list: vi.fn(),
    saveCurrentLogin: vi.fn(),
    getQuota: vi.fn(),
    startDeviceLogin: vi.fn(),
    startBrowserLogin: vi.fn(),
    pollDeviceLogin: vi.fn(),
    cancelDeviceLogin: vi.fn(),
    submitBrowserCallback: vi.fn(),
    switchAccount: vi.fn(),
    removeAccount: vi.fn(),
    removeAccounts: vi.fn(),
    setDisabled: vi.fn(),
  },
}));
const quota = (utilization = 25): SubscriptionQuota => ({
  tool: "codex",
  credentialStatus: "valid",
  credentialMessage: null,
  success: true,
  tiers: [
    { name: "five_hour", utilization, resetsAt: null },
    { name: "seven_day", utilization: utilization + 5, resetsAt: null },
  ],
  extraUsage: null,
  error: null,
  queriedAt: 1,
});
const account = (key: string, isCurrent = false): OfficialAccountDto => ({
  key,
  // Different Vault identities can share the same ChatGPT workspace.
  accountId: "shared-workspace-id",
  displayName: key,
  capturedAt: "2026-10-02",
  isCurrent,
  needsRelogin: false,
  providerId: `line-${key}`,
});
const startedLogin = {
  flowId: "flow-a",
  verificationUrl: "https://example.invalid/device",
  userCode: "TEST-1234",
  expiresAt: "2099-01-01T00:00:00Z",
  expiresInSeconds: 900,
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => {
  vi.clearAllMocks();
  previewMode.enabled = false;
  previewMode.empty = false;
  localStorage.removeItem("chimera.officialAccounts.view");
  localStorage.removeItem("chimera.officialAccounts.refreshMinutes");
  vi.mocked(officialAccountsApi.startBrowserLogin)
    .mockReset()
    .mockResolvedValue({
      ...startedLogin,
      userCode: "",
      verificationUrl: "https://auth.openai.com/oauth/authorize?state=test",
    });
  vi.mocked(officialAccountsApi.startDeviceLogin)
    .mockReset()
    .mockResolvedValue(startedLogin);
  vi.mocked(officialAccountsApi.pollDeviceLogin)
    .mockReset()
    .mockResolvedValue({ status: "pending" });
  vi.mocked(officialAccountsApi.saveCurrentLogin)
    .mockReset()
    .mockResolvedValue("saved");
  vi.mocked(officialAccountsApi.list).mockResolvedValue([]);
  vi.mocked(officialAccountsApi.getQuota)
    .mockReset()
    .mockResolvedValue(quota());
  vi.mocked(officialAccountsApi.switchAccount).mockResolvedValue();
  vi.mocked(officialAccountsApi.cancelDeviceLogin).mockResolvedValue();
  vi.mocked(officialAccountsApi.removeAccount).mockReset().mockResolvedValue();
});
const openAccountManagement = async () => {
  fireEvent.click(await screen.findByRole("button", { name: /^管理全部账号/ }));
};
const headerImport = () =>
  within(
    screen.getByRole("heading", { name: "官方账号" }).closest("header")!,
  ).getByRole("button", { name: "导入本机账号" });

const loginOption = async (method: "browser" | "device") => {
  // Radix schedules focus restoration and menu setup on the next tick.
  // Flush those tasks explicitly when a recovery test controls time.
  const flushMenuTasks = async () => {
    if (vi.isFakeTimers()) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }
  };
  await flushMenuTasks();
  const trigger = screen.getByRole("button", { name: "添加官方账号" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  await flushMenuTasks();
  return screen.getByRole("menuitem", {
    name: method === "device" ? "设备码登录" : "浏览器登录",
  });
};

describe("official account onboarding", () => {
  it("submits a pasted callback and keeps waiting after a recoverable input error", async () => {
    vi.mocked(officialAccountsApi.submitBrowserCallback)
      .mockReset()
      .mockRejectedValueOnce(new Error("回调地址与本次登录不匹配"))
      .mockResolvedValueOnce();
    render(<OfficialAccountsView />);
    fireEvent.click(await screen.findByRole("button", { name: "浏览器登录" }));
    const field = await screen.findByRole("textbox", { name: "回调地址" });
    expect(screen.getByRole("button", { name: "复制授权链接" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "重新打开浏览器" }),
    ).toBeVisible();
    fireEvent.change(field, {
      target: {
        value: "http://localhost:1455/auth/callback?code=test&state=old",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交授权结果" }));
    expect(await screen.findByText("回调地址与本次登录不匹配")).toBeVisible();
    expect(screen.getByText("等待浏览器授权")).toBeVisible();
    const callback =
      "http://localhost:1455/auth/callback?code=test&state=current";
    fireEvent.change(field, { target: { value: callback } });
    fireEvent.click(screen.getByRole("button", { name: "提交授权结果" }));
    await screen.findByText(/已提交，正在等待官方登录确认/);
    expect(officialAccountsApi.submitBrowserCallback).toHaveBeenLastCalledWith(
      "flow-a",
      callback,
    );
    expect(field).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "关闭登录" }));
    await waitFor(() =>
      expect(officialAccountsApi.cancelDeviceLogin).toHaveBeenCalledWith(
        "flow-a",
      ),
    );
  });
  it("keeps the startup guard across unmount and remount", async () => {
    let resolveStart!: (value: typeof startedLogin) => void;
    vi.mocked(officialAccountsApi.startBrowserLogin).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    const first = render(<OfficialAccountsView />);
    fireEvent.click(await screen.findByRole("button", { name: "浏览器登录" }));
    first.unmount();
    render(<OfficialAccountsView />);
    fireEvent.click(await loginOption("device"));
    expect(officialAccountsApi.startDeviceLogin).not.toHaveBeenCalled();
    await act(async () => {
      resolveStart(startedLogin);
    });
    expect(officialAccountsApi.cancelDeviceLogin).toHaveBeenCalledWith(
      "flow-a",
    );
    fireEvent.click(await loginOption("device"));
    await screen.findByText("TEST-1234");
    expect(officialAccountsApi.startDeviceLogin).toHaveBeenCalledOnce();
  });

  it("waits for cancelled startup cleanup before permitting another login", async () => {
    let resolveStart!: (value: typeof startedLogin) => void;
    vi.mocked(officialAccountsApi.startBrowserLogin).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    render(<OfficialAccountsView />);
    fireEvent.click(await screen.findByRole("button", { name: "浏览器登录" }));
    fireEvent.click(screen.getByRole("button", { name: "取消登录" }));
    expect(screen.getByRole("button", { name: "添加官方账号" })).toBeDisabled();
    await act(async () => {
      resolveStart({ ...startedLogin, userCode: "" });
    });
    expect(officialAccountsApi.cancelDeviceLogin).toHaveBeenCalledWith(
      "flow-a",
    );
    expect(screen.getByRole("button", { name: "添加官方账号" })).toBeEnabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("completes browser login through the shared polling and account reload", async () => {
    vi.mocked(officialAccountsApi.pollDeviceLogin).mockResolvedValueOnce({
      status: "completed",
      key: "browser-account",
    });
    const onAccountSwitched = vi.fn();
    render(<OfficialAccountsView onAccountSwitched={onAccountSwitched} />);
    const button = await screen.findByRole("button", {
      name: "浏览器登录",
    });
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(button);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(officialAccountsApi.list).toHaveBeenCalledTimes(2);
    expect(onAccountSwitched).toHaveBeenCalledOnce();
  });

  it("defaults to browser login without displaying a device code", async () => {
    render(<OfficialAccountsView />);
    fireEvent.click(await screen.findByRole("button", { name: "浏览器登录" }));
    expect(
      await screen.findByRole("textbox", { name: "授权链接" }),
    ).toHaveValue("https://auth.openai.com/oauth/authorize?state=test");
    expect(officialAccountsApi.startBrowserLogin).toHaveBeenCalledOnce();
    expect(officialAccountsApi.startDeviceLogin).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "复制代码" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "改用设备码登录" }),
    ).toBeVisible();
  });

  it("cancels the browser flow before switching to device login and back", async () => {
    render(<OfficialAccountsView />);
    fireEvent.click(await screen.findByRole("button", { name: "浏览器登录" }));
    expect(
      await screen.findByRole("textbox", { name: "授权链接" }),
    ).toHaveValue("https://auth.openai.com/oauth/authorize?state=test");
    fireEvent.click(screen.getByRole("button", { name: "改用设备码登录" }));
    await screen.findByText("TEST-1234");
    expect(officialAccountsApi.cancelDeviceLogin).toHaveBeenCalledWith(
      "flow-a",
    );
    expect(
      screen.getByText(/设备码登录需要在 ChatGPT 安全设置中开启/),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "改用浏览器登录" }));
    expect(
      await screen.findByRole("textbox", { name: "授权链接" }),
    ).toHaveValue("https://auth.openai.com/oauth/authorize?state=test");
    expect(officialAccountsApi.startBrowserLogin).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole("button", { name: "复制代码" }),
    ).not.toBeInTheDocument();
  });

  it("does not let an old list response hide an explicitly imported account", async () => {
    let resolveOld!: (accounts: OfficialAccountDto[]) => void;
    vi.mocked(officialAccountsApi.list)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
      )
      .mockResolvedValueOnce([account("newly-imported")]);
    render(<OfficialAccountsView />);
    fireEvent.click(headerImport());
    await waitFor(() =>
      expect(officialAccountsApi.saveCurrentLogin).toHaveBeenCalledOnce(),
    );
    expect(officialAccountsApi.list).toHaveBeenCalledTimes(1);
    await act(async () => resolveOld([]));
    await screen.findByText("newly-imported");
    expect(officialAccountsApi.list).toHaveBeenCalledTimes(2);
    expect(screen.getByText("newly-imported")).toBeVisible();
    expect(screen.queryByText("连接第一个官方账号")).not.toBeInTheDocument();
  });
  it("prioritizes local import while keeping browser login and the add menu clear", async () => {
    render(<OfficialAccountsView />);
    const empty = await screen.findByRole("region", {
      name: "连接第一个官方账号",
    });
    const actions = within(empty).getAllByRole("button");
    expect(actions.map((button) => button.textContent)).toEqual([
      "导入本机账号",
      "浏览器登录",
    ]);
    expect(headerImport()).toHaveTextContent("导入本机账号");
    expect(headerImport().querySelector("svg")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "添加官方账号" }),
    ).toHaveAttribute("aria-haspopup", "menu");
    expect(within(empty).getByText(/保留本地会话记录/)).toBeVisible();
    expect(screen.queryByLabelText("当前官方账号")).not.toBeInTheDocument();
    expect(screen.queryByText(/auth.json 写入记录/)).not.toBeInTheDocument();
    expect(officialAccountsApi.saveCurrentLogin).not.toHaveBeenCalled();
    expect(officialAccountsApi.startBrowserLogin).not.toHaveBeenCalled();
  });
  it("starts the existing device flow only after an explicit click", async () => {
    let resolveStart!: (value: typeof startedLogin) => void;
    vi.mocked(officialAccountsApi.startDeviceLogin).mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    render(<OfficialAccountsView />);
    const add = await loginOption("device");
    expect(officialAccountsApi.startDeviceLogin).not.toHaveBeenCalled();
    fireEvent.click(add);
    await waitFor(() =>
      expect(officialAccountsApi.startDeviceLogin).toHaveBeenCalledOnce(),
    );
    expect(
      screen.getByRole("button", { name: "添加官方账号", hidden: true }),
    ).toBeDisabled();
    await act(async () => {
      resolveStart(startedLogin);
    });
  });
  it("shows real account identity and keeps the current account explicit", async () => {
    vi.mocked(officialAccountsApi.list).mockResolvedValue([
      {
        key: "test",
        accountId: "test",
        displayName: "测试账号",
        isCurrent: true,
        needsRelogin: false,
        capturedAt: "2026-10-02",
      },
    ]);
    render(<OfficialAccountsView />);
    await openAccountManagement();
    await screen.findByText("使用中");
    expect(
      screen.queryByRole("button", { name: "重新应用" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "切换到此账号" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/导入或登录更多账号后/)).toBeVisible();
    expect(screen.queryByText("连接第一个官方账号")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加官方账号" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "浏览器登录" }),
    ).not.toBeInTheDocument();
  });
  it("keeps an add action available when the account list cannot be read", async () => {
    vi.mocked(officialAccountsApi.list).mockRejectedValueOnce(
      new Error("database locked"),
    );
    render(<OfficialAccountsView />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "database locked",
    );
    expect(screen.getByRole("button", { name: "添加官方账号" })).toBeVisible();
    expect(screen.queryByText("连接第一个官方账号")).not.toBeInTheDocument();
  });
});

describe("official account local import", () => {
  it.each(["header", "empty", "menu"] as const)(
    "imports from %s into an account card without starting login or switching",
    async (entry) => {
      vi.mocked(officialAccountsApi.list)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            ...account("local-account", true),
            isSelected: true,
            liveState: "matched",
          },
        ]);
      const onAccountSwitched = vi.fn();
      render(<OfficialAccountsView onAccountSwitched={onAccountSwitched} />);
      const empty = await screen.findByRole("region", {
        name: "连接第一个官方账号",
      });
      if (entry === "menu") {
        fireEvent.keyDown(
          screen.getByRole("button", { name: "添加官方账号" }),
          { key: "ArrowDown" },
        );
        expect(await screen.findAllByRole("menuitem")).toHaveLength(3);
        expect(officialAccountsApi.saveCurrentLogin).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("menuitem", { name: "导入本机账号" }));
      } else {
        fireEvent.click(
          entry === "header"
            ? headerImport()
            : within(empty).getByRole("button", { name: "导入本机账号" }),
        );
      }
      const card = await screen.findByRole("region", { name: "Codex 当前登录" });
      expect(within(card).getByText("local-account")).toBeVisible();
      expect(within(card).getByText("当前使用中")).toBeVisible();
      await waitFor(() =>
        expect(officialAccountsApi.getQuota).toHaveBeenCalledExactlyOnceWith(
          "local-account",
        ),
      );
      expect(
        officialAccountsApi.saveCurrentLogin,
      ).toHaveBeenCalledExactlyOnceWith();
      expect(officialAccountsApi.startBrowserLogin).not.toHaveBeenCalled();
      expect(officialAccountsApi.startDeviceLogin).not.toHaveBeenCalled();
      expect(officialAccountsApi.switchAccount).not.toHaveBeenCalled();
      expect(onAccountSwitched).toHaveBeenCalledOnce();
      expect(
        screen.queryByRole("region", { name: "连接第一个官方账号" }),
      ).not.toBeInTheDocument();
    },
  );

  it("keeps import failures visible and supports retry without losing the browser choice", async () => {
    vi.mocked(officialAccountsApi.saveCurrentLogin)
      .mockRejectedValueOnce(new Error("未找到可导入的登录"))
      .mockResolvedValueOnce("recovered");
    vi.mocked(officialAccountsApi.list)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([account("recovered", true)]);
    render(<OfficialAccountsView />);
    const empty = await screen.findByRole("region", {
      name: "连接第一个官方账号",
    });
    fireEvent.click(
      within(empty).getByRole("button", { name: "导入本机账号" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("未能导入本机账号");
    expect(alert).toHaveTextContent("未找到可导入的登录");
    expect(
      within(empty).getByRole("button", { name: "浏览器登录" }),
    ).toBeEnabled();
    fireEvent.click(within(alert).getByRole("button", { name: "重试导入" }));
    expect(await screen.findByRole("region", { name: "Codex 当前登录" })).toHaveTextContent("recovered");
    expect(officialAccountsApi.saveCurrentLogin).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("prevents duplicate imports and concurrent login while a local import is pending", async () => {
    let finishImport!: (key: string) => void;
    vi.mocked(officialAccountsApi.saveCurrentLogin).mockReturnValueOnce(
      new Promise((resolve) => {
        finishImport = resolve;
      }),
    );
    render(<OfficialAccountsView />);
    const empty = await screen.findByRole("region", {
      name: "连接第一个官方账号",
    });
    const importButton = within(empty).getByRole("button", {
      name: "导入本机账号",
    });
    fireEvent.click(importButton);
    fireEvent.click(importButton);
    expect(importButton).toBeDisabled();
    expect(headerImport()).toBeDisabled();
    const browser = within(empty).getByRole("button", { name: "浏览器登录" });
    expect(browser).toBeDisabled();
    fireEvent.click(browser);
    expect(screen.getByRole("button", { name: "添加官方账号" })).toBeDisabled();
    expect(officialAccountsApi.saveCurrentLogin).toHaveBeenCalledOnce();
    expect(officialAccountsApi.startBrowserLogin).not.toHaveBeenCalled();
    await act(async () => {
      finishImport("saved");
    });
    await waitFor(() => expect(headerImport()).toBeEnabled());
  });

  it.each(["header", "tile"] as const)(
    "uses the %s add menu and returns focus after browser login is cancelled",
    async (entry) => {
      vi.mocked(officialAccountsApi.list).mockResolvedValue([
        account("current", true),
      ]);
      render(<OfficialAccountsView />);
      if (entry === "tile") {
        await openAccountManagement();
        fireEvent.click(screen.getByRole("button", { name: "网格视图" }));
      }
      const trigger = await screen.findByRole("button", {
        name: entry === "header" ? "添加官方账号" : "添加另一个账号",
      });
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
      const items = await screen.findAllByRole("menuitem");
      expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
        "导入本机账号",
        "浏览器登录",
        "设备码登录",
      ]);
      expect(officialAccountsApi.saveCurrentLogin).not.toHaveBeenCalled();
      expect(officialAccountsApi.startBrowserLogin).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("menuitem", { name: "浏览器登录" }));
      const dialog = await screen.findByRole("dialog", {
        name: "添加官方账号",
      });
      await waitFor(() =>
        expect(officialAccountsApi.startBrowserLogin).toHaveBeenCalledOnce(),
      );
      expect(officialAccountsApi.startDeviceLogin).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole("button", { name: "取消登录" }));
      await waitFor(() => expect(dialog).not.toBeInTheDocument());
      expect(trigger).toHaveFocus();
      expect(officialAccountsApi.cancelDeviceLogin).toHaveBeenCalledWith(
        "flow-a",
      );
    },
  );
});

describe("official account live identity", () => {
  it.each([
    ["stored A but live B", true],
    ["third-party live route", false],
    ["unreadable live login", false],
    ["different user in the same workspace", true],
  ])("keeps A switchable with %s", async (_scenario, bIsCurrent) => {
    vi.mocked(officialAccountsApi.list).mockResolvedValue([
      account("vault-a"),
      account("vault-b", bIsCurrent),
    ]);
    render(<OfficialAccountsView />);
    await openAccountManagement();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    const [a, b] = screen.getAllByRole("article");
    expect(a).toHaveAttribute("data-current", "false");
    expect(within(a).queryByText("使用中")).not.toBeInTheDocument();
    expect(
      within(a).getByRole("button", { name: "切换到此账号" }),
    ).toBeEnabled();
    expect(b).toHaveAttribute("data-current", String(bIsCurrent));
    if (!bIsCurrent) {
      expect(
        screen.queryByRole("region", { name: "Codex 当前登录" }),
      ).not.toBeInTheDocument();
    }
    fireEvent.click(within(a).getByRole("button", { name: "切换到此账号" }));
    const dialog = await screen.findByRole("dialog", {
      name: "切换到 vault-a？",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认切换" }));
    await waitFor(() =>
      expect(officialAccountsApi.switchAccount).toHaveBeenCalledWith("vault-a"),
    );
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });

  it("keeps only the confirmed current account marked in a multi-account list", async () => {
    vi.mocked(officialAccountsApi.list).mockResolvedValue([
      { ...account("current", true), isSelected: true, liveState: "matched" },
      { ...account("saved"), liveState: "matched" },
    ]);
    render(<OfficialAccountsView />);
    await openAccountManagement();
    const cards = await screen.findAllByRole("article");
    expect(within(cards[0]).getByText("使用中")).toBeVisible();
    expect(
      within(cards[0]).queryByRole("button", { name: /切换|重新应用/ }),
    ).not.toBeInTheDocument();
    expect(within(cards[1]).getByText("备用")).toBeVisible();
    const switchButton = within(cards[1]).getByRole("button", {
      name: "切换到此账号",
    });
    expect(switchButton).toBeEnabled();
    expect(screen.getByText(/在下方账号中选择/)).toBeVisible();
    switchButton.focus();
    fireEvent.click(switchButton);
    const dialog = await screen.findByRole("dialog", {
      name: "切换到 saved？",
    });
    expect(
      within(dialog).getByText("保留已有会话，不修改会话内容"),
    ).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(switchButton).toHaveFocus();
    expect(officialAccountsApi.switchAccount).not.toHaveBeenCalled();
  });
});

describe("official account dialogs", () => {
  it("requires confirmation and describes the real switch without a simulated restart or backup path", async () => {
    vi.mocked(officialAccountsApi.list).mockResolvedValue([
      {
        key: "next",
        accountId: "next",
        displayName: "备用账号",
        isCurrent: false,
        needsRelogin: false,
        capturedAt: "2026-10-02",
        providerId: "next-line",
      },
    ]);
    render(<OfficialAccountsView />);
    fireEvent.click(
      await screen.findByRole("button", { name: "切换到此账号" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "切换到 备用账号？",
    });
    expect(officialAccountsApi.switchAccount).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/不会自动关闭或重启 Codex/)).toBeVisible();
    expect(
      within(dialog).queryByText(/DeepSeek|APPDATA|以后切换账号时不再询问/),
    ).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认切换" }));
    await waitFor(() =>
      expect(officialAccountsApi.switchAccount).toHaveBeenCalledWith("next"),
    );
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });
  it("cancels the active device flow when the login dialog closes", async () => {
    vi.mocked(officialAccountsApi.startDeviceLogin).mockResolvedValue({
      flowId: "preview-flow",
      verificationUrl: "https://example.invalid/device",
      userCode: "TEST-1234",
      expiresAt: "2026-10-02T16:00:00Z",
      expiresInSeconds: 900,
    });
    render(<OfficialAccountsView />);
    const loginButton = await screen.findByRole("button", {
      name: "添加官方账号",
    });
    loginButton.focus();
    fireEvent.click(await loginOption("device"));
    const dialog = await screen.findByRole("dialog", { name: "添加官方账号" });
    expect(within(dialog).getByText("TEST-1234")).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消登录" }));
    await waitFor(() =>
      expect(officialAccountsApi.cancelDeviceLogin).toHaveBeenCalledWith(
        "preview-flow",
      ),
    );
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(loginButton).toHaveFocus();
  });
});

describe("official account Vault quotas", () => {
  it("queries and renders each Vault identity separately even for a shared account id", async () => {
    vi.mocked(officialAccountsApi.list).mockResolvedValue([
      account("vault-a", true),
      account("vault-b"),
    ]);
    vi.mocked(officialAccountsApi.getQuota).mockImplementation(async (key) =>
      quota(key === "vault-a" ? 25 : 60),
    );
    render(<OfficialAccountsView />);
    await openAccountManagement();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    const [first, second] = screen.getAllByRole("article");
    await waitFor(() => expect(within(first).getByText("25%")).toBeVisible());
    expect(within(first).getByText("30%")).toBeVisible();
    expect(within(second).getByText("60%")).toBeVisible();
    expect(within(second).getByText("65%")).toBeVisible();
    const current = screen.getByRole("region", { name: "Codex 当前登录" });
    expect(within(current).getByText("75%")).toBeVisible();
    expect(within(current).queryByText("60%")).not.toBeInTheDocument();
    expect(officialAccountsApi.getQuota).toHaveBeenCalledWith("vault-a");
    expect(officialAccountsApi.getQuota).toHaveBeenCalledWith("vault-b");
    expect(officialAccountsApi.getQuota).toHaveBeenCalledTimes(2);
  });

  it("skips tombstoned accounts and offers login after a rejected credential response", async () => {
    vi.mocked(officialAccountsApi.list).mockResolvedValue([
      { ...account("logged-out"), needsRelogin: true },
      account("rejected-login", true),
    ]);
    vi.mocked(officialAccountsApi.getQuota).mockResolvedValue({
      ...quota(),
      success: false,
      credentialStatus: "expired",
      tiers: [],
      error: "官方账号登录已失效，请重新登录 (HTTP 401)",
    });
    render(<OfficialAccountsView />);
    await openAccountManagement();
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "重新登录" })).toHaveLength(
        2,
      ),
    );
    expect(officialAccountsApi.getQuota).toHaveBeenCalledExactlyOnceWith(
      "rejected-login",
    );
    expect(screen.queryByText("登录有效")).not.toBeInTheDocument();
    // The card now holds one message instead of one per fixed window.
    const current = screen.getByRole("region", { name: "Codex 当前登录" });
    expect(within(current).getByText("重新登录后可查询额度")).toBeVisible();
  });

  it("keeps switching available when the quota service is blocked (HTTP 403)", async () => {
    vi.mocked(officialAccountsApi.list).mockResolvedValue([account("blocked")]);
    vi.mocked(officialAccountsApi.getQuota).mockResolvedValue({
      ...quota(),
      success: false,
      credentialStatus: "valid",
      tiers: [],
      error: "无法访问官方额度服务（HTTP 403），可能是网络或地区限制",
    });
    render(<OfficialAccountsView />);
    await openAccountManagement();
    const row = await screen.findByRole("article");
    expect(
      await within(row).findByText(
        "无法访问官方额度服务（HTTP 403），可能是网络或地区限制",
      ),
    ).toBeVisible();
    expect(
      within(row).getByRole("button", { name: "切换到此账号" }),
    ).toBeEnabled();
    expect(
      within(row).queryByRole("button", { name: "重新登录" }),
    ).not.toBeInTheDocument();
    expect(within(row).queryByText("需要重新登录")).not.toBeInTheDocument();
  });

  it("keeps switching for an expired access token without querying the service", async () => {
    vi.mocked(officialAccountsApi.list).mockResolvedValue([
      { ...account("expired-token"), accessExpired: true },
      account("fresh"),
    ]);
    render(<OfficialAccountsView />);
    await openAccountManagement();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    const [expired] = screen.getAllByRole("article");
    expect(
      within(expired).getByText("登录待续期 · 切换后由 Codex 自动续期"),
    ).toBeVisible();
    expect(
      within(expired).getByRole("button", { name: "切换到此账号" }),
    ).toBeEnabled();
    expect(within(expired).queryByText("需要重新登录")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(officialAccountsApi.getQuota).toHaveBeenCalledExactlyOnceWith(
        "fresh",
      ),
    );
  });

  it("treats an access-expired quota answer as renewable, not as a failure", async () => {
    vi.mocked(officialAccountsApi.list).mockResolvedValue([account("raced")]);
    vi.mocked(officialAccountsApi.getQuota).mockResolvedValue({
      ...quota(),
      success: false,
      tiers: [],
      error: "令牌已过期，切换后由 Codex 续期",
      queriedAt: null,
      accessExpired: true,
    });
    render(<OfficialAccountsView />);
    await openAccountManagement();
    expect(
      await screen.findByText("登录待续期 · 切换后由 Codex 自动续期"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "切换到此账号" })).toBeEnabled();
    expect(screen.queryByText(/部分额度未更新/)).not.toBeInTheDocument();
  });

  it("shows a quota failure for one account without losing another account's result", async () => {
    vi.mocked(officialAccountsApi.list).mockResolvedValue([
      account("unreachable", true),
      account("healthy"),
    ]);
    vi.mocked(officialAccountsApi.getQuota).mockImplementation(async (key) => {
      if (key === "unreachable") throw new Error("Network error");
      return quota();
    });
    render(<OfficialAccountsView />);
    await openAccountManagement();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    const [first, second] = screen.getAllByRole("article");
    await waitFor(() =>
      expect(within(first).getByText("额度查询失败，请刷新重试")).toBeVisible(),
    );
    expect(within(first).queryByText("尚未查询额度")).not.toBeInTheDocument();
    // A failed query is not a sign-in problem.
    expect(within(first).queryByText("需要重新登录")).not.toBeInTheDocument();
    expect(screen.queryByText("登录有效")).not.toBeInTheDocument();
    expect(
      within(first).queryByRole("button", { name: "重新应用" }),
    ).not.toBeInTheDocument();
    expect(
      within(second).getByRole("button", { name: "切换到此账号" }),
    ).toBeEnabled();
    expect(within(second).getByText("25%")).toBeVisible();
    const current = screen.getByRole("region", { name: "Codex 当前登录" });
    expect(within(current).getByText("额度查询失败，请刷新重试")).toBeVisible();
  });
});

describe("device login recovery", () => {
  const beginTimedLogin = async () => {
    const view = render(<OfficialAccountsView />);
    const button = await loginOption("device");
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(button);
    });
    return view;
  };
  const tick = async (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  it("keeps startup failures visible with region guidance and allows retry", async () => {
    vi.mocked(officialAccountsApi.startDeviceLogin).mockRejectedValueOnce(
      new Error("service unavailable"),
    );
    render(<OfficialAccountsView />);
    fireEvent.click(await loginOption("device"));
    const dialog = await screen.findByRole("dialog", { name: "添加官方账号" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "service unavailable",
    );
    expect(
      within(dialog).getByText("unsupported_country_region_territory"),
    ).toBeVisible();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "重新获取代码" }),
    );
    expect(await within(dialog).findByText("TEST-1234")).toBeVisible();
    expect(officialAccountsApi.startDeviceLogin).toHaveBeenCalledTimes(2);
  });

  it("retains a terminal error instead of silently closing the dialog", async () => {
    vi.mocked(officialAccountsApi.pollDeviceLogin).mockResolvedValue({
      status: "failed",
      error: "authorization rejected",
    });
    await beginTimedLogin();
    await tick(2500);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "authorization rejected",
    );
    expect(screen.getByRole("dialog")).toBeVisible();
    await tick(10000);
    expect(officialAccountsApi.pollDeviceLogin).toHaveBeenCalledTimes(1);
    expect(officialAccountsApi.cancelDeviceLogin).toHaveBeenCalledWith(
      "flow-a",
    );
  });

  it("stops after three consecutive IPC failures and surfaces a retry action", async () => {
    vi.mocked(officialAccountsApi.pollDeviceLogin).mockRejectedValue(
      new Error("network down"),
    );
    await beginTimedLogin();
    await tick(2500);
    expect(screen.getByRole("status")).toHaveTextContent("正在重试（1/3）");
    await tick(5000);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "连续 3 次无法获取授权状态：network down",
    );
    await tick(10000);
    expect(officialAccountsApi.pollDeviceLogin).toHaveBeenCalledTimes(3);
  });

  it("ignores completion of a cancelled attempt after a new login starts", async () => {
    let finish!: (value: { status: "completed" }) => void;
    vi.mocked(officialAccountsApi.pollDeviceLogin).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await beginTimedLogin();
    await tick(2500);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "取消登录" }));
    });
    vi.mocked(officialAccountsApi.startDeviceLogin).mockResolvedValue({
      ...startedLogin,
      flowId: "flow-b",
      userCode: "NEW-5678",
    });
    const nextDeviceLogin = await loginOption("device");
    await act(async () => {
      fireEvent.click(nextDeviceLogin);
    });
    await act(async () => {
      finish({ status: "completed" });
    });
    expect(screen.getByText("NEW-5678")).toBeVisible();
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(officialAccountsApi.list).toHaveBeenCalledTimes(1);
  });

  it("cancels the native flow when unmounted", async () => {
    const view = await beginTimedLogin();
    view.unmount();
    expect(officialAccountsApi.cancelDeviceLogin).toHaveBeenCalledWith(
      "flow-a",
    );
    await tick(5000);
    expect(officialAccountsApi.pollDeviceLogin).not.toHaveBeenCalled();
  });

  it("turns local expiry into a stopped, retryable error", async () => {
    vi.mocked(officialAccountsApi.startDeviceLogin).mockResolvedValue({
      ...startedLogin,
      expiresInSeconds: 1,
    });
    await beginTimedLogin();
    await tick(1000);
    expect(screen.getByRole("alert")).toHaveTextContent("一次性代码已过期");
    expect(screen.getByRole("button", { name: "重新获取代码" })).toBeEnabled();
    expect(officialAccountsApi.pollDeviceLogin).not.toHaveBeenCalled();
  });

  it("imports an existing login only after an explicit click", async () => {
    render(<OfficialAccountsView />);
    const button = headerImport();
    expect(officialAccountsApi.saveCurrentLogin).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() =>
      expect(officialAccountsApi.saveCurrentLogin).toHaveBeenCalledOnce(),
    );
    expect(officialAccountsApi.startDeviceLogin).not.toHaveBeenCalled();
  });
});

describe("official account automatic quota refresh", () => {
  const storageKey = "chimera.officialAccounts.refreshMinutes";
  const advance = async (minutes: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(minutes * 60_000);
    });
  };
  const open = async () => {
    vi.useFakeTimers();
    vi.mocked(officialAccountsApi.list).mockResolvedValue([
      account("auto", true),
      { ...account("expired"), needsRelogin: true },
    ]);
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<OfficialAccountsView />);
    });
    fireEvent.click(screen.getByRole("button", { name: /^管理全部账号/ }));
    return view;
  };

  it("fetches on entry, skips expired accounts, refreshes every five minutes and stops on unmount", async () => {
    const view = await open();
    expect(officialAccountsApi.getQuota).toHaveBeenCalledExactlyOnceWith(
      "auto",
    );
    await advance(4);
    expect(officialAccountsApi.getQuota).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(officialAccountsApi.getQuota).toHaveBeenCalledTimes(2);
    view.unmount();
    await advance(10);
    expect(officialAccountsApi.getQuota).toHaveBeenCalledTimes(2);
  });

  it("changes cadence immediately, persists off, and still allows entry and manual refresh", async () => {
    const view = await open();
    fireEvent.change(screen.getByLabelText("自动刷新额度"), {
      target: { value: "1" },
    });
    expect(localStorage.getItem(storageKey)).toBe("1");
    await advance(1);
    expect(officialAccountsApi.getQuota).toHaveBeenCalledTimes(2);
    fireEvent.change(screen.getByLabelText("自动刷新额度"), {
      target: { value: "0" },
    });
    await advance(15);
    expect(officialAccountsApi.getQuota).toHaveBeenCalledTimes(2);
    view.unmount();
    await open();
    expect(screen.getByLabelText("自动刷新额度")).toHaveValue("0");
    expect(officialAccountsApi.getQuota).toHaveBeenCalledTimes(3);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    });
    expect(officialAccountsApi.getQuota).toHaveBeenCalledTimes(4);
    // 刷新额度 asks for a new reading; opening the page does not.
    expect(officialAccountsApi.getQuota).toHaveBeenLastCalledWith(
      expect.any(String),
      true,
    );
  });

  it("does not overlap slow requests or update an unmounted page", async () => {
    let finish!: (value: SubscriptionQuota) => void;
    vi.mocked(officialAccountsApi.getQuota).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = await open();
    await advance(15);
    expect(officialAccountsApi.list).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "刷新" })).toBeDisabled();
    view.unmount();
    await act(async () => {
      finish(quota());
    });
    await advance(5);
    expect(officialAccountsApi.list).toHaveBeenCalledTimes(1);
  });

  it("keeps last known quotas with one inline warning through repeated failures and recovers", async () => {
    await open();
    vi.mocked(officialAccountsApi.getQuota).mockRejectedValue(
      new Error("offline"),
    );
    await advance(15);
    expect(screen.getAllByText("25%").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/部分额度未更新/)).toHaveLength(1);
    vi.mocked(officialAccountsApi.list).mockRejectedValueOnce(
      new Error("offline"),
    );
    await advance(5);
    expect(screen.getByRole("heading", { name: "auto" })).toBeVisible();
    vi.mocked(officialAccountsApi.getQuota).mockResolvedValue(quota(40));
    await advance(5);
    expect(screen.queryByText(/部分额度未更新/)).not.toBeInTheDocument();
    expect(screen.getAllByText("40%").length).toBeGreaterThan(0);
  });

  it.each([429, 503])(
    "retains quotas on fulfilled HTTP %s failures and replaces them after recovery",
    async (status) => {
      await open();
      vi.mocked(officialAccountsApi.getQuota).mockResolvedValue({
        ...quota(),
        success: false,
        credentialStatus: "valid",
        tiers: [],
        error: `API error (HTTP ${status})`,
      });
      await advance(10);
      expect(screen.getByRole("progressbar", { name: "5 小时额度剩余" })).toHaveAttribute("aria-valuenow", "75");
      expect(screen.getByRole("progressbar", { name: "5 小时额度已用" })).toHaveAttribute("aria-valuenow", "25");
      expect(screen.getByRole("progressbar", { name: "7 天额度剩余" })).toHaveAttribute("aria-valuenow", "70");
      expect(screen.getByRole("progressbar", { name: "7 天额度已用" })).toHaveAttribute("aria-valuenow", "30");
      expect(screen.getAllByText(/部分额度未更新/)).toHaveLength(1);
      expect(
        screen.queryByRole("button", { name: "重新应用" }),
      ).not.toBeInTheDocument();
      expect(screen.getByText("使用中")).toBeVisible();
      vi.mocked(officialAccountsApi.getQuota).mockResolvedValue(quota(40));
      await advance(5);
      expect(screen.queryByText(/部分额度未更新/)).not.toBeInTheDocument();
      expect(screen.queryByText("25%")).not.toBeInTheDocument();
      expect(screen.getByRole("progressbar", { name: "5 小时额度剩余" })).toHaveAttribute("aria-valuenow", "60");
      expect(screen.getByRole("progressbar", { name: "5 小时额度已用" })).toHaveAttribute("aria-valuenow", "40");
    },
  );

  it("uses a safe default for corrupt storage and tolerates unavailable storage", async () => {
    localStorage.setItem(storageKey, "-1");
    const view = await open();
    expect(screen.getByLabelText("自动刷新额度")).toHaveValue("5");
    view.unmount();
    const read = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    try {
      await open();
      fireEvent.change(screen.getByLabelText("自动刷新额度"), {
        target: { value: "1" },
      });
      await advance(1);
      expect(screen.getByLabelText("自动刷新额度")).toHaveValue("1");
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
  });

  it("serializes StrictMode entry requests and keeps a single timer", async () => {
    vi.useFakeTimers();
    vi.mocked(officialAccountsApi.list).mockResolvedValue([account("strict")]);
    await act(async () => {
      render(
        <StrictMode>
          <OfficialAccountsView />
        </StrictMode>,
      );
    });
    expect(officialAccountsApi.getQuota).toHaveBeenCalledExactlyOnceWith(
      "strict",
    );
    const calls = vi.mocked(officialAccountsApi.list).mock.calls.length;
    await advance(5);
    expect(officialAccountsApi.list).toHaveBeenCalledTimes(calls + 1);
    // The timer polls only Codex's current account; "strict" is not current.
    expect(officialAccountsApi.getQuota).toHaveBeenCalledTimes(1);
  });

  it("polls only the current account and queries the others on entry and manual refresh", async () => {
    vi.useFakeTimers();
    vi.mocked(officialAccountsApi.list).mockResolvedValue([
      account("live", true),
      account("other"),
    ]);
    await act(async () => {
      render(<OfficialAccountsView />);
    });
    fireEvent.click(screen.getByRole("button", { name: /^管理全部账号/ }));
    expect(officialAccountsApi.getQuota).toHaveBeenCalledTimes(2);
    await advance(5);
    expect(officialAccountsApi.getQuota).toHaveBeenCalledTimes(3);
    // Design change: a timer tick asks for a new reading (the stored one is
    // answered for 5 minutes, which would make shorter intervals do nothing).
    expect(officialAccountsApi.getQuota).toHaveBeenLastCalledWith("live", true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    });
    expect(officialAccountsApi.getQuota).toHaveBeenCalledTimes(5);
  });

  it("re-reads the local list on window focus without querying quotas", async () => {
    vi.useFakeTimers();
    vi.mocked(officialAccountsApi.list).mockResolvedValue([
      account("live", true),
    ]);
    await act(async () => {
      render(<OfficialAccountsView />);
    });
    fireEvent.click(screen.getByRole("button", { name: /^管理全部账号/ }));
    const listCalls = vi.mocked(officialAccountsApi.list).mock.calls.length;
    vi.mocked(officialAccountsApi.list).mockResolvedValue([
      account("live", true),
      account("added-elsewhere"),
    ]);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(officialAccountsApi.list).toHaveBeenCalledTimes(listCalls + 1);
    expect(officialAccountsApi.getQuota).toHaveBeenCalledTimes(1);
    const added = screen.getAllByRole("article")[1];
    expect(within(added).getByText("尚未查询额度")).toBeVisible();
    // The new account is queried on demand.
    await act(async () => {
      fireEvent.click(within(added).getByRole("button", { name: "查询" }));
    });
    expect(officialAccountsApi.getQuota).toHaveBeenLastCalledWith(
      "added-elsewhere",
    );
    expect(within(added).getByText("25%")).toBeVisible();
  });

  it("surfaces unsuccessful quota responses and does not keep an expired quota visible", async () => {
    await open();
    vi.mocked(officialAccountsApi.getQuota).mockResolvedValue({
      ...quota(),
      success: false,
      credentialStatus: "expired",
      tiers: [],
    });
    await advance(5);
    expect(screen.getAllByText(/部分额度未更新/)).toHaveLength(1);
    expect(screen.queryByText("25%")).not.toBeInTheDocument();
    expect(screen.getAllByText("需要重新登录")).toHaveLength(2);
  });

  it("skips background ticks while hidden", async () => {
    await open();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    try {
      await advance(10);
      expect(officialAccountsApi.getQuota).toHaveBeenCalledTimes(1);
      visibility.mockReturnValue("visible");
      await advance(5);
      expect(officialAccountsApi.getQuota).toHaveBeenCalledTimes(2);
    } finally {
      visibility.mockRestore();
    }
  });
});

describe("official account quota windows", () => {
  // 2026-10-13 10:24 local time, like the QA harness clock.
  const NOW = new Date(2026, 9, 13, 10, 24, 0);
  const at = (hours: number, minutes = 0) =>
    new Date(2026, 9, 13, hours, minutes, 0).toISOString();
  const windows = (
    tiers: SubscriptionQuota["tiers"],
    queriedAt = new Date(2026, 9, 13, 10, 22).getTime(),
  ): SubscriptionQuota => ({ ...quota(), tiers, queriedAt });
  const openAt = async (accounts: OfficialAccountDto[]) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.mocked(officialAccountsApi.list).mockResolvedValue(accounts);
    await act(async () => {
      render(<OfficialAccountsView />);
    });
    fireEvent.click(screen.getByRole("button", { name: /^管理全部账号/ }));
  };

  it("renders every returned window shortest first with countdown, exact time and query time", async () => {
    vi.mocked(officialAccountsApi.getQuota).mockResolvedValue(
      windows([
        { name: "30_day", utilization: 20, resetsAt: null },
        { name: "seven_day", utilization: 59, resetsAt: at(23, 0) },
        { name: "five_hour", utilization: 38, resetsAt: at(13, 55) },
      ]),
    );
    await openAt([account("live", true)]);
    const current = screen.getByRole("region", { name: "Codex 当前登录" });
    const bars = within(current).getAllByRole("progressbar");
    expect(bars.map((bar) => bar.getAttribute("aria-label"))).toEqual([
      "5 小时额度剩余",
      "7 天额度剩余",
      "30 天额度剩余",
    ]);
    expect(bars[0]).toHaveAttribute("aria-valuenow", "62");
    expect(bars[0]).toHaveAttribute("aria-valuemin", "0");
    expect(bars[0]).toHaveAttribute("aria-valuemax", "100");
    expect(bars[0]).toHaveAttribute("aria-valuetext", "剩余 62%");
    const reset = within(current).getByText(/^3 小时 31 分钟后重置 ·/);
    expect(reset).toBeVisible();
    expect(reset).toHaveTextContent("3 小时 31 分钟后重置 · 10月13日 13:55");
    // Date and time wrap as one unit, never "13:55" alone on a line.
    expect(within(reset).getByText("10月13日 13:55")).toHaveClass(
      "quota-meter-exact",
    );
    expect(within(current).getByText("重置时间未知")).toBeVisible();
    expect(within(current).getByText("查询于 10:22")).toBeVisible();
    const row = screen.getByRole("article");
    expect(within(row).getAllByRole("progressbar")).toHaveLength(3);
    expect(within(row).getByRole("progressbar", { name: "5 小时额度已用" })).toHaveAttribute("aria-valuenow", "38");
    expect(bars[0].firstElementChild).toHaveStyle({width: "62%"});
    expect(within(row).getByText("3 小时后重置")).toHaveAttribute(
      "title",
      "10月13日 13:55 重置",
    );
    // Next to 刷新 as well as on the card.
    expect(screen.getAllByText("查询于 10:22")).toHaveLength(2);
  });

  it("shows a free plan's 30-day window and highlights a nearly used-up window", async () => {
    vi.mocked(officialAccountsApi.getQuota).mockResolvedValue(
      windows([{ name: "30_day", utilization: 95, resetsAt: null }]),
    );
    await openAt([account("free", true)]);
    const current = screen.getByRole("region", { name: "Codex 当前登录" });
    const bar = within(current).getByRole("progressbar", {
      name: "30 天额度剩余",
    });
    expect(bar).toHaveAttribute("aria-valuenow", "5");
    expect(bar.closest(".quota-meter")).toHaveAttribute("data-low", "true");
    expect(within(current).getByText("5%")).toBeVisible();
    expect(within(current).queryByText(/5 小时/)).not.toBeInTheDocument();
  });

  it("says the service returned no windows instead of pretending to wait", async () => {
    vi.mocked(officialAccountsApi.getQuota).mockResolvedValue(windows([]));
    await openAt([account("empty", true)]);
    expect(screen.getAllByText("服务未返回额度数据")).toHaveLength(2);
    expect(screen.queryByText("尚未查询额度")).not.toBeInTheDocument();
  });
});

describe("official account identity", () => {
  it("shows the line name, the email and a plan tag", async () => {
    vi.mocked(officialAccountsApi.list).mockResolvedValue([
      {
        ...account("main", true),
        displayName: "ChatGPT · li***@gmail.com",
        email: "li***@gmail.com",
        lineName: "OpenAI 官方 · 主力",
        planType: "plus",
      },
      {
        ...account("work"),
        displayName: "ChatGPT · ch***@acme.cn",
        email: "ch***@acme.cn",
        lineName: "ChatGPT · ch***@acme.cn",
        planType: "team",
      },
    ]);
    render(<OfficialAccountsView />);
    await openAccountManagement();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    const [main, work] = screen.getAllByRole("article");
    expect(within(main).getByText("OpenAI 官方 · 主力")).toBeVisible();
    expect(within(main).getByText("li***@gmail.com")).toBeVisible();
    expect(within(main).getByText("Plus")).toBeVisible();
    expect(within(main).getByText("使用中")).toBeVisible();
    // A default line name repeats the email, so the email is the title.
    expect(within(work).getByText("ch***@acme.cn")).toBeVisible();
    expect(
      within(work).queryByText("ChatGPT · ch***@acme.cn"),
    ).not.toBeInTheDocument();
    expect(within(work).getByText("Team")).toBeVisible();
    const current = screen.getByRole("region", { name: "Codex 当前登录" });
    expect(within(current).getByText("当前使用中")).toBeVisible();
    expect(within(current).getByText("Plus")).toBeVisible();
  });
});

describe("unreadable official accounts", () => {
  const unreadable: OfficialAccountDto = {
    key: "unreadable",
    accountId: "",
    displayName: "无法读取的账号",
    email: null,
    capturedAt: "",
    isCurrent: false,
    needsRelogin: true,
    unreadable: true,
    providerId: "line-unreadable",
  };

  it("lists the account with a repair message and never queries it", async () => {
    vi.mocked(officialAccountsApi.list).mockResolvedValue([
      unreadable,
      account("healthy"),
    ]);
    render(<OfficialAccountsView />);
    await openAccountManagement();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    const [row] = screen.getAllByRole("article");
    expect(within(row).getByText("无法读取的账号")).toBeVisible();
    expect(
      within(row).getByText(
        "无法读取（可能因系统密码重置或配置迁移），请重新登录或删除",
      ),
    ).toBeVisible();
    expect(within(row).getByRole("button", { name: "重新登录" })).toBeEnabled();
    await waitFor(() =>
      expect(officialAccountsApi.getQuota).toHaveBeenCalledExactlyOnceWith(
        "healthy",
      ),
    );
    fireEvent.click(within(row).getByRole("button", { name: "重新登录" }));
    await waitFor(() =>
      expect(officialAccountsApi.startBrowserLogin).toHaveBeenCalledOnce(),
    );
  });

  it("can be removed after a confirmation that states the consequence", async () => {
    vi.mocked(officialAccountsApi.list)
      .mockResolvedValueOnce([unreadable])
      .mockResolvedValueOnce([]);
    const onAccountSwitched = vi.fn();
    render(<OfficialAccountsView onAccountSwitched={onAccountSwitched} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "删除无法读取的账号" }),
    );
    const dialog = await screen.findByRole("alertdialog", {
      name: "删除账号“无法读取的账号”？",
    });
    expect(within(dialog).getByText(/已无法读取/)).toBeVisible();
    expect(within(dialog).getByText(/使用它的线路会保留/)).toBeVisible();
    expect(officialAccountsApi.removeAccount).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "删除账号" }));
    await waitFor(() =>
      expect(officialAccountsApi.removeAccount).toHaveBeenCalledWith(
        "unreadable",
      ),
    );
    await screen.findByText("连接第一个官方账号");
    expect(onAccountSwitched).toHaveBeenCalledOnce();
  });
});

describe("official account read-only preview", () => {
  it("allows browsing and selection while refusing all account writes", async () => {
    previewMode.enabled = true;
    render(<OfficialAccountsView />);
    await openAccountManagement();
    fireEvent.click(screen.getByRole("button", { name: "网格视图" }));
    const cards = await screen.findAllByRole("article");
    expect(cards).toHaveLength(5);
    const writeButtons = [
      headerImport(),
      screen.getByRole("button", { name: "添加官方账号" }),
      screen.getByRole("button", { name: "添加另一个账号" }),
      ...screen.getAllByRole("button", { name: "切换到此账号" }),
      screen.getByRole("button", { name: "重新登录" }),
      screen.getByRole("button", { name: "启用" }),
      ...screen.getAllByRole("button", { name: /^编辑|^删除/ }),
    ];
    for (const button of writeButtons) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    fireEvent.click(within(cards[0]).getByRole("checkbox"));
    const batch = screen.getByRole("region", { name: "批量操作" });
    expect(batch).toHaveTextContent("已选 1 项");
    const remove = within(batch).getByRole("button", { name: "批量删除" });
    expect(remove).toBeDisabled();
    fireEvent.click(remove);
    fireEvent.click(within(batch).getByRole("button", { name: "取消选择" }));
    expect(
      screen.queryByRole("region", { name: "批量操作" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "列表视图" }));
    expect(screen.getByRole("button", { name: "列表视图" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    for (const method of [
      "list",
      "getQuota",
      "saveCurrentLogin",
      "startBrowserLogin",
      "startDeviceLogin",
      "switchAccount",
      "removeAccount",
      "removeAccounts",
      "setDisabled",
    ] as const) {
      expect(officialAccountsApi[method]).not.toHaveBeenCalled();
    }
  });

  it("keeps both empty-state login choices read-only", async () => {
    previewMode.enabled = true;
    previewMode.empty = true;
    render(<OfficialAccountsView />);
    const empty = await screen.findByRole("region", {
      name: "连接第一个官方账号",
    });
    for (const button of within(empty).getAllByRole("button")) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(headerImport()).toBeDisabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(officialAccountsApi.list).not.toHaveBeenCalled();
    expect(officialAccountsApi.saveCurrentLogin).not.toHaveBeenCalled();
    expect(officialAccountsApi.startBrowserLogin).not.toHaveBeenCalled();
    expect(officialAccountsApi.startDeviceLogin).not.toHaveBeenCalled();
  });
});

describe("official account removal", () => {
  it("does nothing until confirmed and keeps the account on cancel", async () => {
    vi.mocked(officialAccountsApi.list).mockResolvedValue([account("keep")]);
    render(<OfficialAccountsView />);
    fireEvent.click(await screen.findByRole("button", { name: "删除keep" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "删除账号“keep”？",
    });
    expect(
      within(dialog).getByText(/Codex 与 ChatGPT 中已有的登录不受影响/),
    ).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(officialAccountsApi.removeAccount).not.toHaveBeenCalled();
    expect(screen.getByRole("article")).toBeVisible();
  });
});

describe("Codex live login", () => {
  it("reapplies a single selected account only after confirming a live mismatch", async () => {
    vi.mocked(officialAccountsApi.list).mockResolvedValue([
      { ...account("selected"), isSelected: true, liveState: "mismatch" },
    ]);
    render(<OfficialAccountsView />);
    const card = await screen.findByRole("article");
    const reapply = within(card).getByRole("button", { name: "重新应用" });
    expect(
      within(card).queryByRole("button", { name: "切换到此账号" }),
    ).not.toBeInTheDocument();
    reapply.focus();
    fireEvent.click(reapply);
    const dialog = await screen.findByRole("dialog", {
      name: "切换到 selected？",
    });
    expect(officialAccountsApi.switchAccount).not.toHaveBeenCalled();
    expect(
      within(dialog).getByText("保留已有会话，不修改会话内容"),
    ).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(reapply).toHaveFocus();
    expect(officialAccountsApi.switchAccount).not.toHaveBeenCalled();
  });

  it("offers to save an unsaved live login instead of hiding the current card silently", async () => {
    vi.mocked(officialAccountsApi.list).mockResolvedValue([
      { ...account("saved"), liveState: "unsaved" },
    ]);
    render(<OfficialAccountsView />);
    const banner = (
      await screen.findByText("Codex 当前登录的账号还没有保存")
    ).closest(".accounts-banner") as HTMLElement;
    expect(
      screen.queryByRole("region", { name: "Codex 当前登录" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(banner).getByRole("button", { name: "导入本机账号" }),
    );
    await waitFor(() =>
      expect(officialAccountsApi.saveCurrentLogin).toHaveBeenCalledOnce(),
    );
  });

  it("offers to reapply the selected account when Codex uses another login", async () => {
    vi.mocked(officialAccountsApi.list).mockResolvedValue([
      { ...account("selected"), isSelected: true, liveState: "mismatch" },
      { ...account("in-use", true), liveState: "mismatch" },
    ]);
    render(<OfficialAccountsView />);
    await openAccountManagement();
    const banner = (
      await screen.findByText("Codex 当前没有使用所选账号")
    ).closest(".accounts-banner") as HTMLElement;
    expect(within(banner).getByText(/已选择「selected」/)).toBeVisible();
    const cards = screen.getAllByRole("article");
    expect(
      within(cards[0]).getByRole("button", { name: "重新应用" }),
    ).toBeEnabled();
    expect(
      within(cards[1]).queryByRole("button", { name: /重新应用|切换到此账号/ }),
    ).not.toBeInTheDocument();

    const current = screen.getByRole("region", { name: "Codex 当前登录" });
    expect(
      within(current).getByRole("heading", { name: "in-use" }),
    ).toBeVisible();
    fireEvent.click(within(banner).getByRole("button", { name: "重新应用" }));
    const dialog = await screen.findByRole("dialog", {
      name: "切换到 selected？",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认切换" }));
    await waitFor(() =>
      expect(officialAccountsApi.switchAccount).toHaveBeenCalledWith(
        "selected",
      ),
    );
  });

  it("explains a third-party route without a warning", async () => {
    vi.mocked(officialAccountsApi.list).mockResolvedValue([
      { ...account("idle"), liveState: "third_party" },
    ]);
    render(<OfficialAccountsView />);
    expect(await screen.findByText(/Codex 正在使用第三方线路/)).toBeVisible();
    expect(
      screen.queryByText("Codex 当前没有使用所选账号"),
    ).not.toBeInTheDocument();
  });
});

describe("Codex CLI not found", () => {
  it("explains the desktop-app search and makes importing the local login the way forward", async () => {
    vi.mocked(officialAccountsApi.startBrowserLogin).mockRejectedValueOnce(
      new Error(
        "未找到 Codex CLI（已查找 PATH、常见安装位置和 Codex 桌面版自带的 CLI），无法添加账号；也可以在 Codex 中登录后选择「导入本机账号」 (Codex CLI was not found; you can also sign in inside Codex and save the current login)",
      ),
    );
    render(<OfficialAccountsView />);
    fireEvent.click(await screen.findByRole("button", { name: "浏览器登录" }));
    const dialog = await screen.findByRole("dialog", { name: "添加官方账号" });
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("未找到 Codex CLI");
    expect(alert).toHaveTextContent(/桌面版自带的 CLI/);
    expect(dialog).not.toHaveTextContent("was not found");
    expect(
      within(dialog).queryByRole("button", { name: "改用设备码登录" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "导入本机账号" }),
    );
    await waitFor(() =>
      expect(officialAccountsApi.saveCurrentLogin).toHaveBeenCalledOnce(),
    );
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });

  it("shows other login failures in Chinese only", async () => {
    vi.mocked(officialAccountsApi.startDeviceLogin).mockRejectedValueOnce(
      new Error(
        "Codex 登录未完成，请重试 (The Codex login did not complete; try again)",
      ),
    );
    render(<OfficialAccountsView />);
    fireEvent.click(await loginOption("device"));
    const dialog = await screen.findByRole("dialog", { name: "添加官方账号" });
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Codex 登录未完成，请重试");
    expect(alert).not.toHaveTextContent("did not complete");
  });
});
