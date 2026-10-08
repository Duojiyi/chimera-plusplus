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
    switchAccount: vi.fn(),
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
});
describe("official account onboarding", () => {
  it("keeps the startup guard across unmount and remount", async () => {
    let resolveStart!: (value: typeof startedLogin) => void;
    vi.mocked(officialAccountsApi.startBrowserLogin).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    const first = render(<OfficialAccountsView />);
    fireEvent.click(
      await screen.findByRole("button", { name: "登录并添加账号" }),
    );
    first.unmount();
    render(<OfficialAccountsView />);
    fireEvent.click(await screen.findByRole("button", { name: "设备码登录" }));
    expect(officialAccountsApi.startDeviceLogin).not.toHaveBeenCalled();
    await act(async () => {
      resolveStart(startedLogin);
    });
    expect(officialAccountsApi.cancelDeviceLogin).toHaveBeenCalledWith(
      "flow-a",
    );
    fireEvent.click(screen.getByRole("button", { name: "设备码登录" }));
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
    fireEvent.click(
      await screen.findByRole("button", { name: "登录并添加账号" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "取消登录" }));
    expect(screen.getByRole("button", { name: "设备码登录" })).toBeDisabled();
    await act(async () => {
      resolveStart({ ...startedLogin, userCode: "" });
    });
    expect(officialAccountsApi.cancelDeviceLogin).toHaveBeenCalledWith(
      "flow-a",
    );
    expect(screen.getByRole("button", { name: "设备码登录" })).toBeEnabled();
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
      name: "登录并添加账号",
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
    fireEvent.click(
      await screen.findByRole("button", { name: "登录并添加账号" }),
    );
    await screen.findByText(
      "https://auth.openai.com/oauth/authorize?state=test",
    );
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
    fireEvent.click(
      await screen.findByRole("button", { name: "登录并添加账号" }),
    );
    await screen.findByText(
      "https://auth.openai.com/oauth/authorize?state=test",
    );
    fireEvent.click(screen.getByRole("button", { name: "改用设备码登录" }));
    await screen.findByText("TEST-1234");
    expect(officialAccountsApi.cancelDeviceLogin).toHaveBeenCalledWith(
      "flow-a",
    );
    expect(
      screen.getByText(/设备码登录需要在 ChatGPT 安全设置中开启/),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "改用浏览器登录" }));
    await screen.findByText(
      "https://auth.openai.com/oauth/authorize?state=test",
    );
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
    fireEvent.click(screen.getByRole("button", { name: "导入本机登录" }));
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
  it("shows a clear login action without empty quota or placeholder history", async () => {
    render(<OfficialAccountsView />);
    await screen.findByText("连接第一个官方账号");
    // Exactly one add action while empty; importing stays a secondary option.
    expect(screen.getByRole("button", { name: "设备码登录" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "添加官方账号" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入本机登录" })).toBeVisible();
    expect(screen.getByText(/登录凭据仅保存在本机/)).toBeVisible();
    expect(screen.queryByLabelText("当前官方账号")).not.toBeInTheDocument();
    expect(screen.queryByText(/auth.json 写入记录/)).not.toBeInTheDocument();
  });
  it("starts the existing device flow only after an explicit click", async () => {
    let resolveStart!: (value: typeof startedLogin) => void;
    vi.mocked(officialAccountsApi.startDeviceLogin).mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    render(<OfficialAccountsView />);
    const add = await screen.findByRole("button", { name: "设备码登录" });
    expect(officialAccountsApi.startDeviceLogin).not.toHaveBeenCalled();
    fireEvent.click(add);
    await waitFor(() =>
      expect(officialAccountsApi.startDeviceLogin).toHaveBeenCalledOnce(),
    );
    expect(add).toBeDisabled();
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
    await screen.findByRole("button", { name: "重新应用" });
    expect(screen.getByRole("button", { name: "重新应用" })).toBeEnabled();
    expect(screen.getByText("使用中")).toBeInTheDocument();
    expect(screen.queryByText("连接第一个官方账号")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加官方账号" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "登录并添加账号" }),
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
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    const [a, b] = screen.getAllByRole("article");
    expect(a).toHaveAttribute("data-current", "false");
    expect(within(a).queryByText("使用中")).not.toBeInTheDocument();
    expect(within(a).getByRole("button", { name: "切换" })).toBeEnabled();
    expect(b).toHaveAttribute("data-current", String(bIsCurrent));
    if (!bIsCurrent) {
      expect(
        screen.queryByRole("region", { name: "当前官方账号" }),
      ).not.toBeInTheDocument();
    }
    fireEvent.click(within(a).getByRole("button", { name: "切换" }));
    const dialog = await screen.findByRole("dialog", {
      name: "切换到 vault-a？",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认切换" }));
    await waitFor(() =>
      expect(officialAccountsApi.switchAccount).toHaveBeenCalledWith("vault-a"),
    );
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });

  it("allows reapplying a confirmed account when Codex may have changed since the last read", async () => {
    vi.mocked(officialAccountsApi.list).mockResolvedValue([
      account("vault-a", true),
    ]);
    render(<OfficialAccountsView />);
    fireEvent.click(await screen.findByRole("button", { name: "重新应用" }));
    const dialog = await screen.findByRole("dialog", {
      name: "切换到 vault-a？",
    });
    expect(officialAccountsApi.switchAccount).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认切换" }));
    await waitFor(() =>
      expect(officialAccountsApi.switchAccount).toHaveBeenCalledWith("vault-a"),
    );
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
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
    fireEvent.click(await screen.findByRole("button", { name: "切换" }));
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
      name: "设备码登录",
    });
    loginButton.focus();
    fireEvent.click(loginButton);
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
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    const [first, second] = screen.getAllByRole("article");
    await waitFor(() => expect(within(first).getByText("75%")).toBeVisible());
    expect(within(first).getByText("70%")).toBeVisible();
    expect(within(second).getByText("40%")).toBeVisible();
    expect(within(second).getByText("35%")).toBeVisible();
    const current = screen.getByRole("region", { name: "当前官方账号" });
    expect(within(current).getByText("75%")).toBeVisible();
    expect(within(current).queryByText("40%")).not.toBeInTheDocument();
    expect(officialAccountsApi.getQuota).toHaveBeenCalledWith("vault-a");
    expect(officialAccountsApi.getQuota).toHaveBeenCalledWith("vault-b");
    expect(officialAccountsApi.getQuota).toHaveBeenCalledTimes(2);
  });

  it("skips tombstoned accounts and offers login after a rejected credential response", async () => {
    vi.mocked(officialAccountsApi.list).mockResolvedValue([
      { ...account("logged-out"), needsRelogin: true },
      account("expired-token", true),
    ]);
    vi.mocked(officialAccountsApi.getQuota).mockResolvedValue({
      ...quota(),
      success: false,
      credentialStatus: "expired",
      tiers: [],
      error: "HTTP 401",
    });
    render(<OfficialAccountsView />);
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "重新登录" })).toHaveLength(
        2,
      ),
    );
    expect(officialAccountsApi.getQuota).toHaveBeenCalledExactlyOnceWith(
      "expired-token",
    );
    expect(screen.queryByText("登录有效")).not.toBeInTheDocument();
    const current = screen.getByRole("region", { name: "当前官方账号" });
    expect(within(current).getAllByText("重新登录后可查询额度")).toHaveLength(
      2,
    );
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
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    const [first, second] = screen.getAllByRole("article");
    await waitFor(() =>
      expect(within(first).getByText("额度查询失败，请刷新重试")).toBeVisible(),
    );
    expect(within(first).queryByText("尚未获取额度")).not.toBeInTheDocument();
    expect(within(first).getByText("已保存登录")).toBeVisible();
    expect(screen.queryByText("登录有效")).not.toBeInTheDocument();
    expect(
      within(first).getByRole("button", { name: "重新应用" }),
    ).toBeEnabled();
    expect(within(second).getByText("75%")).toBeVisible();
    const current = screen.getByRole("region", { name: "当前官方账号" });
    expect(
      within(current).getAllByText("额度查询失败，请刷新重试"),
    ).toHaveLength(2);
  });
});

describe("device login recovery", () => {
  const beginTimedLogin = async () => {
    const view = render(<OfficialAccountsView />);
    const button = await screen.findByRole("button", {
      name: "设备码登录",
    });
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
    fireEvent.click(await screen.findByRole("button", { name: "设备码登录" }));
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
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "设备码登录" }));
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
    const button = await screen.findByRole("button", { name: "导入本机登录" });
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
    expect(screen.getAllByText("75%").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/部分额度未更新/)).toHaveLength(1);
    vi.mocked(officialAccountsApi.list).mockRejectedValueOnce(
      new Error("offline"),
    );
    await advance(5);
    expect(screen.getByRole("heading", { name: "auto" })).toBeVisible();
    vi.mocked(officialAccountsApi.getQuota).mockResolvedValue(quota(40));
    await advance(5);
    expect(screen.queryByText(/部分额度未更新/)).not.toBeInTheDocument();
    expect(screen.getAllByText("60%").length).toBeGreaterThan(0);
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
      expect(screen.getAllByText("75%")).toHaveLength(2);
      expect(screen.getAllByText("70%")).toHaveLength(2);
      expect(screen.getAllByText(/部分额度未更新/)).toHaveLength(1);
      expect(screen.getByText("已保存登录")).toBeVisible();
      vi.mocked(officialAccountsApi.getQuota).mockResolvedValue(quota(40));
      await advance(5);
      expect(screen.queryByText(/部分额度未更新/)).not.toBeInTheDocument();
      expect(screen.queryByText("75%")).not.toBeInTheDocument();
      expect(screen.getAllByText("60%")).toHaveLength(2);
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
    expect(officialAccountsApi.getQuota).toHaveBeenCalledTimes(2);
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
    expect(screen.queryByText("75%")).not.toBeInTheDocument();
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
