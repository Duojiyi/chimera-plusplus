import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  BINDINGS_CHANGED_EVENT,
  ClaudeAccountsCard,
  errorText,
  resetText,
} from "@/components/claude-accounts/ClaudeAccountsCard";
import {
  claudeAccountsApi,
  type ClaudeCodeAccounts,
  type ClaudeDesktopSwapOutcome,
  type ClaudeDesktopSwapStatus,
  type ClaudeQuota,
} from "@/lib/api/claudeAccounts";

vi.mock("@/lib/api/claudeAccounts", () => ({
  claudeAccountsApi: {
    listCode: vi.fn(),
    saveCurrentCode: vi.fn(),
    switchCode: vi.fn(),
    renameCode: vi.fn(),
    deleteCode: vi.fn(),
    codeQuota: vi.fn(),
    addSecret: vi.fn(),
    setDisabled: vi.fn(),
    reorder: vi.fn(),
    openSession: vi.fn(),
    sessionCommands: vi.fn(),
    listBindings: vi.fn(),
    setBinding: vi.fn(),
    removeBinding: vi.fn(),
    pickFolder: vi.fn(),
    usageOverview: vi.fn(),
    desktopSwapStatus: vi.fn(),
    captureDesktopLogin: vi.fn(),
    switchDesktop: vi.fn(),
    prepareDesktopLogin: vi.fn(),
    exportLogins: vi.fn(),
    importLogins: vi.fn(),
    beginBrowserLogin: vi.fn(),
    pollBrowserLogin: vi.fn(),
    cancelBrowserLogin: vi.fn(),
    listDesktop: vi.fn(),
    createDesktop: vi.fn(),
    renameDesktop: vi.fn(),
    deleteDesktop: vi.fn(),
    launchDesktop: vi.fn(),
    desktopQuota: vi.fn(),
  },
  DEFAULT_DESKTOP_ID: "default",
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const api = vi.mocked(claudeAccountsApi);

const accounts: ClaudeCodeAccounts = {
  supported: true,
  unsupportedReason: null,
  browserLoginSupported: true,
  sessionsSupported: true,
  live: {
    signedIn: true,
    email: "work@example.com",
    plan: "Max",
    fingerprint: "abcd1234",
    savedId: "work",
  },
  accounts: [
    {
      id: "work",
      name: "工作",
      email: "work@example.com",
      plan: "Max",
      fingerprint: "abcd1234",
      createdAt: "2026-10-01",
      updatedAt: "2026-10-01",
      isCurrent: true,
      needsRelogin: false,
      unreadable: false,
      kind: "oauth",
      disabled: false,
      sessionRunning: false,
    },
    {
      id: "me",
      name: "个人",
      email: "me@example.com",
      plan: "Pro",
      fingerprint: "ffff0000",
      createdAt: "2026-10-02",
      updatedAt: "2026-10-02",
      isCurrent: false,
      needsRelogin: false,
      unreadable: false,
      kind: "oauth",
      disabled: false,
      sessionRunning: false,
    },
  ],
};

const future = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();

const quota: ClaudeQuota = {
  status: "fresh",
  windows: [
    {
      name: "five_hour",
      label: "5 小时",
      kind: "session",
      utilization: 42,
      resetsAt: future(133),
      reset: false,
    },
    {
      name: "seven_day",
      label: "每周",
      kind: "weekly",
      utilization: 10,
      resetsAt: future(3 * 1440),
      reset: true,
      resetAt: new Date().toISOString(),
    },
    {
      name: "model_weekly:Fable",
      label: "每周 · Fable",
      kind: "model",
      utilization: 33,
      resetsAt: null,
      reset: false,
    },
  ],
  extraUsage: null,
  fetchedAt: Date.now(),
};

beforeEach(() => {
  vi.resetAllMocks();
  api.listCode.mockResolvedValue(structuredClone(accounts));
  api.codeQuota.mockResolvedValue(quota);
  api.listDesktop.mockResolvedValue([]);
  api.reorder.mockResolvedValue();
  api.desktopSwapStatus.mockResolvedValue({
    supported: true,
    running: false,
    signedIn: false,
    snapshots: [],
  });
  api.desktopQuota.mockResolvedValue({
    email: null,
    plan: null,
    quota: { status: "not_signed_in", windows: [], extraUsage: null },
  });
});

describe("ClaudeAccountsCard · Claude Code", () => {
  it("lists saved logins with quota, plan and fingerprint but never a token", async () => {
    // A stray token field in a response must never be rendered.
    const leaky = structuredClone(accounts) as ClaudeCodeAccounts & {
      accessToken?: string;
    };
    leaky.accessToken = "sk-ant-oat-leak";
    Object.assign(leaky.accounts[1], { accessToken: "sk-ant-oat-leak" });
    api.listCode.mockResolvedValue(leaky);
    const { container } = render(<ClaudeAccountsCard mode="code" />);
    const list = await screen.findByRole("list", {
      name: "已保存的 Claude Code 账号",
    });
    expect(within(list).getByText("使用中")).toBeInTheDocument();
    expect(within(list).getByText("#abcd1234")).toBeInTheDocument();
    await waitFor(() => expect(api.codeQuota).toHaveBeenCalledTimes(2));
    expect(api.codeQuota).toHaveBeenCalledWith("work", false);
    const meters = await screen.findAllByRole("meter", { name: "5 小时已用" });
    expect(meters[0]).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getAllByText(/2 小时 13 分后重置/)[0]).toBeInTheDocument();
    expect(screen.getAllByText(/^已重置/)[0]).toBeInTheDocument();
    expect(screen.getAllByText("Fable")[0]).toBeInTheDocument();
    expect(container.textContent).not.toContain("sk-ant-oat-leak");
  });

  it("shows why the live login could not be read instead of signed out", async () => {
    api.listCode.mockResolvedValue({
      ...structuredClone(accounts),
      live: {
        signedIn: false,
        email: null,
        plan: null,
        fingerprint: null,
        savedId: null,
      },
      liveError: "IO 错误: .claude.json: 拒绝访问。",
    });
    render(<ClaudeAccountsCard mode="code" />);
    expect(await screen.findByText("无法读取登录文件")).toBeInTheDocument();
    expect(screen.getByText(/拒绝访问/)).toBeInTheDocument();
  });

  it("re-saves an already saved live login before the login guide", async () => {
    api.saveCurrentCode.mockResolvedValue(
      structuredClone(accounts.accounts[0]),
    );
    render(<ClaudeAccountsCard mode="code" />);
    await pickFromMenu(/^添加账号/, /在终端登录后保存/);
    await waitFor(() => expect(api.saveCurrentCode).toHaveBeenCalledWith());
    fireEvent.click(
      await screen.findByRole("button", { name: "我已登录，保存为账号" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /^保存/ }));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        "仍是「工作」，未检测到新的登录",
        expect.anything(),
      ),
    );
  });

  it("refreshes one account's quota on demand", async () => {
    render(<ClaudeAccountsCard mode="code" />);
    fireEvent.click(
      await screen.findByRole("button", { name: "刷新 个人 的额度" }),
    );
    await waitFor(() => expect(api.codeQuota).toHaveBeenCalledWith("me", true));
  });

  it("shows clear quota states", async () => {
    api.codeQuota.mockResolvedValue({
      status: "needs_relogin",
      windows: [],
      extraUsage: null,
      fetchedAt: null,
    });
    render(<ClaudeAccountsCard mode="code" />);
    expect((await screen.findAllByText(/需要重新登录/))[0]).toBeInTheDocument();
  });

  it("asks before switching while Claude Code runs, then forces on confirm", async () => {
    api.switchCode
      .mockResolvedValueOnce({ status: "claude_running", autoSavedId: null })
      .mockResolvedValueOnce({ status: "switched", autoSavedId: null });
    render(<ClaudeAccountsCard mode="code" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /切换到此账号/ }),
    );
    await waitFor(() =>
      expect(api.switchCode).toHaveBeenCalledWith("me", false),
    );
    fireEvent.click(await screen.findByRole("button", { name: "仍然切换" }));
    await waitFor(() =>
      expect(api.switchCode).toHaveBeenCalledWith("me", true),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "已切换到「个人」",
        expect.anything(),
      ),
    );
  });

  it("names exactly what a delete removes", async () => {
    api.deleteCode.mockResolvedValue();
    render(<ClaudeAccountsCard mode="code" />);
    await pickFromMenu("个人 的更多操作", /^删除$/);
    expect(await screen.findByText("删除「个人」？")).toBeInTheDocument();
    expect(
      screen.getByText(/只删除 Chimera 保存的这份登录（me@example.com）/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(api.deleteCode).toHaveBeenCalledWith("me"));
  });

  it("saves the live login first before guiding a new sign-in", async () => {
    api.listCode.mockResolvedValue({
      ...structuredClone(accounts),
      live: { ...accounts.live, savedId: null, email: "new@example.com" },
    });
    api.saveCurrentCode.mockResolvedValue({
      ...accounts.accounts[0],
      id: "new",
      name: "new@example.com",
    });
    render(<ClaudeAccountsCard mode="code" />);
    await pickFromMenu(/^添加账号/, /在终端登录后保存/);
    await waitFor(() => expect(api.saveCurrentCode).toHaveBeenCalledWith());
    expect(await screen.findByText("登录新的 Claude 账号")).toBeInTheDocument();
  });

  it("explains when switching is unsupported", async () => {
    api.listCode.mockResolvedValue({
      ...structuredClone(accounts),
      supported: false,
      unsupportedReason: "macOS 上暂不支持",
    });
    render(<ClaudeAccountsCard mode="code" />);
    expect(await screen.findByText("macOS 上暂不支持")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /切换到此账号/ })).toBeNull();
    expect(api.codeQuota).not.toHaveBeenCalled();
  });
});

describe("ClaudeAccountsCard · Claude Desktop", () => {
  it("shows the default account's plan, email and quota from its own sign-in", async () => {
    api.desktopQuota.mockResolvedValue({
      email: "desk@example.com",
      plan: "Pro",
      quota,
    });
    render(<ClaudeAccountsCard mode="desktop" />);
    expect(await screen.findByText("desk@example.com")).toBeInTheDocument();
    expect(
      within(
        screen.getByRole("list", { name: "Claude Desktop 账号" }),
      ).getByText("Pro"),
    ).toBeInTheDocument();
    expect(api.desktopQuota).toHaveBeenCalledWith("default", false);
    const meters = await screen.findAllByRole("meter", { name: "5 小时已用" });
    expect(meters[0]).toHaveAttribute("aria-valuenow", "42");
    fireEvent.click(
      screen.getByRole("button", { name: "刷新 默认账号 的额度" }),
    );
    await waitFor(() =>
      expect(api.desktopQuota).toHaveBeenCalledWith("default", true),
    );
  });

  it("asks to open Claude Desktop when its sign-in has expired", async () => {
    api.desktopQuota.mockResolvedValue({
      email: null,
      plan: "Max 5x",
      quota: { status: "live_expired", windows: [], extraUsage: null },
    });
    render(<ClaudeAccountsCard mode="desktop" />);
    expect(
      await screen.findByText(/打开一次这个账号的 Claude Desktop 会自动续期/),
    ).toBeInTheDocument();
  });

  it("does not show a quota for a signed-out default account", async () => {
    render(<ClaudeAccountsCard mode="desktop" />);
    expect(await screen.findByText("默认账号")).toBeInTheDocument();
    await waitFor(() => expect(api.desktopQuota).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: "刷新 默认账号 的额度" }),
    ).toBeNull();
  });

  it("shows the read-only default and adds a profile that opens at once", async () => {
    api.createDesktop.mockResolvedValue({
      id: "p1",
      name: "个人号",
      createdAt: "2026-10-30",
      initialized: false,
      signedIn: false,
    });
    api.launchDesktop.mockResolvedValue();
    render(<ClaudeAccountsCard mode="desktop" />);
    expect(await screen.findByText("默认账号")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /添加 Desktop 账号/ }));
    fireEvent.change(await screen.findByLabelText("账号名称"), {
      target: { value: "个人号" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建并打开" }));
    await waitFor(() =>
      expect(api.createDesktop).toHaveBeenCalledWith("个人号"),
    );
    await waitFor(() => expect(api.launchDesktop).toHaveBeenCalledWith("p1"));
  });

  it("closes the dialog once created, so a failed launch cannot duplicate it", async () => {
    api.createDesktop.mockResolvedValue({
      id: "p1",
      name: "个人号",
      createdAt: "2026-10-30",
      initialized: false,
      signedIn: false,
    });
    api.launchDesktop.mockRejectedValue("Claude Desktop 正在运行。");
    render(<ClaudeAccountsCard mode="desktop" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /添加 Desktop 账号/ }),
    );
    fireEvent.change(await screen.findByLabelText("账号名称"), {
      target: { value: "个人号" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建并打开" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Claude Desktop 正在运行。"),
    );
    expect(screen.queryByRole("button", { name: "创建并打开" })).toBeNull();
    expect(api.createDesktop).toHaveBeenCalledTimes(1);
  });

  it("surfaces a refused launch", async () => {
    api.listDesktop.mockResolvedValue([
      {
        id: "p1",
        name: "个人号",
        createdAt: "2026-10-30",
        initialized: true,
        signedIn: false,
      },
    ]);
    api.launchDesktop.mockRejectedValue("Claude Desktop 正在运行。");
    render(<ClaudeAccountsCard mode="desktop" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /打开 Claude Desktop/ }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Claude Desktop 正在运行。"),
    );
  });

  it("delete confirmation names the profile folder and what stays", async () => {
    api.listDesktop.mockResolvedValue([
      {
        id: "p1",
        name: "个人号",
        createdAt: "2026-10-30",
        initialized: true,
        signedIn: true,
      },
    ]);
    render(<ClaudeAccountsCard mode="desktop" />);
    fireEvent.click(await screen.findByRole("button", { name: "删除 个人号" }));
    expect(
      await screen.findByText(/不影响系统默认的 Claude Desktop/),
    ).toBeInTheDocument();
  });
});

/** Opens a menu by its trigger button and chooses an item (Radix menus need real pointer events). */
async function pickFromMenu(trigger: RegExp | string, item: RegExp | string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: trigger }));
  await user.click(await screen.findByRole("menuitem", { name: item }));
}

describe("ClaudeAccountsCard · adding accounts and moving logins as files", () => {
  const savedAccount = {
    ...accounts.accounts[1],
    id: "new",
    name: "new@example.com",
    email: "new@example.com",
  };

  it("offers every way to add an account in one menu", async () => {
    const user = userEvent.setup();
    render(<ClaudeAccountsCard mode="code" />);
    await user.click(await screen.findByRole("button", { name: /^添加账号/ }));
    for (const item of [
      /从浏览器授权添加/,
      /粘贴令牌或 API Key/,
      /导入凭证文件/,
      /在终端登录后保存/,
      /导出凭证文件/,
    ])
      expect(await screen.findByRole("menuitem", { name: item })).toBeVisible();
  });

  it("hides browser authorization where the app cannot start it", async () => {
    const user = userEvent.setup();
    api.listCode.mockResolvedValue({
      ...structuredClone(accounts),
      browserLoginSupported: false,
    });
    render(<ClaudeAccountsCard mode="code" />);
    await user.click(await screen.findByRole("button", { name: /^添加账号/ }));
    expect(
      await screen.findByRole("menuitem", { name: /导入凭证文件/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: /从浏览器授权添加/ }),
    ).toBeNull();
  });

  it("has no add menu where saved logins are unsupported", async () => {
    api.listCode.mockResolvedValue({
      ...structuredClone(accounts),
      supported: false,
      unsupportedReason: "macOS 上暂不支持",
      accounts: [],
    });
    render(<ClaudeAccountsCard mode="code" />);
    expect(await screen.findByText("macOS 上暂不支持")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^添加账号/ })).toBeNull();
  });

  it("warns that the export is plaintext before it opens the save dialog", async () => {
    api.exportLogins.mockResolvedValue({
      path: "D:/backup/chimera-claude-logins.json",
      count: 2,
      skipped: 0,
    });
    render(<ClaudeAccountsCard mode="code" />);
    await pickFromMenu(/^添加账号/, /导出凭证文件/);
    expect(
      await screen.findByText("导出的文件里是明文令牌"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/拿到它的人可以直接登录这些 Claude 账号/),
    ).toBeInTheDocument();
    expect(api.exportLogins).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "我了解，选择保存位置" }),
    );
    await waitFor(() => expect(api.exportLogins).toHaveBeenCalledWith());
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "已导出 2 个登录",
        expect.objectContaining({
          description: expect.stringContaining("chimera-claude-logins.json"),
        }),
      ),
    );
  });

  it("says nothing when the save dialog is cancelled", async () => {
    api.exportLogins.mockResolvedValue(null);
    render(<ClaudeAccountsCard mode="code" />);
    await pickFromMenu(/^添加账号/, /导出凭证文件/);
    fireEvent.click(
      await screen.findByRole("button", { name: "我了解，选择保存位置" }),
    );
    await waitFor(() => expect(api.exportLogins).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByText("导出的文件里是明文令牌")).toBeNull(),
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("cannot export when nothing is saved", async () => {
    const user = userEvent.setup();
    api.listCode.mockResolvedValue({
      ...structuredClone(accounts),
      accounts: [],
    });
    render(<ClaudeAccountsCard mode="code" />);
    await user.click(await screen.findByRole("button", { name: /^添加账号/ }));
    expect(
      await screen.findByRole("menuitem", { name: /导出凭证文件/ }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("reports what an import added, updated and skipped, and reloads", async () => {
    api.importLogins.mockResolvedValue({
      imported: [savedAccount],
      updated: [{ ...accounts.accounts[0], name: "工作" }],
      skipped: [{ email: "me@example.com", reason: "已经保存了相同的登录" }],
    });
    render(<ClaudeAccountsCard mode="code" />);
    await pickFromMenu(/^添加账号/, /导入凭证文件/);
    expect(await screen.findByText("导入完成")).toBeInTheDocument();
    expect(
      screen.getByText("新增 1 个，更新 1 个，跳过 1 个。"),
    ).toBeInTheDocument();
    expect(screen.getByText("已经保存了相同的登录")).toBeInTheDocument();
    await waitFor(() => expect(api.listCode).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    await waitFor(() => expect(screen.queryByText("导入完成")).toBeNull());
  });

  it("passes on what an import wants the user to know", async () => {
    api.importLogins.mockResolvedValue({
      imported: [savedAccount],
      updated: [],
      skipped: [],
      notes: ["「new@example.com」的文件里没有账号信息（oauthAccount）。"],
    });
    render(<ClaudeAccountsCard mode="code" />);
    await pickFromMenu(/^添加账号/, /导入凭证文件/);
    expect(await screen.findByRole("note")).toHaveTextContent(
      "文件里没有账号信息",
    );
  });

  it("does not reload when the import dialog is cancelled or nothing was added", async () => {
    api.importLogins.mockResolvedValueOnce(null);
    render(<ClaudeAccountsCard mode="code" />);
    await pickFromMenu(/^添加账号/, /导入凭证文件/);
    await waitFor(() => expect(api.importLogins).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("导入完成")).toBeNull();

    api.importLogins.mockResolvedValueOnce({
      imported: [],
      updated: [],
      skipped: [{ email: null, reason: "文件里重复出现的同一账号" }],
    });
    await pickFromMenu(/^添加账号/, /导入凭证文件/);
    expect(await screen.findByText("导入完成")).toBeInTheDocument();
    expect(screen.getByText("未识别的账号")).toBeInTheDocument();
    expect(api.listCode).toHaveBeenCalledTimes(1);
  });

  it("shows why an import was refused", async () => {
    api.importLogins.mockRejectedValue(
      new Error("无效输入: 这个文件是加密的，请先解密再导入"),
    );
    render(<ClaudeAccountsCard mode="code" />);
    await pickFromMenu(/^添加账号/, /导入凭证文件/);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "这个文件是加密的，请先解密再导入",
      ),
    );
  });

  it("waits for the browser authorization, then saves and reloads", async () => {
    api.beginBrowserLogin.mockResolvedValue("flow-1");
    api.pollBrowserLogin
      .mockResolvedValueOnce({ state: "waiting" })
      .mockResolvedValue({
        state: "done",
        account: savedAccount,
        created: true,
      });
    render(<ClaudeAccountsCard mode="code" />);
    await pickFromMenu(/^添加账号/, /从浏览器授权添加/);
    expect(
      await screen.findByText("在浏览器里授权 Claude 账号"),
    ).toBeInTheDocument();
    expect(screen.getByText(/等待授权完成/)).toBeInTheDocument();
    expect(api.beginBrowserLogin).toHaveBeenCalledTimes(1);
    await waitFor(
      () =>
        expect(toast.success).toHaveBeenCalledWith(
          "已添加「new@example.com」",
          expect.anything(),
        ),
      { timeout: 6000 },
    );
    expect(api.pollBrowserLogin).toHaveBeenCalledWith("flow-1");
    await waitFor(() =>
      expect(screen.queryByText("在浏览器里授权 Claude 账号")).toBeNull(),
    );
    await waitFor(() => expect(api.listCode).toHaveBeenCalledTimes(2));
    expect(api.cancelBrowserLogin).not.toHaveBeenCalled();
  }, 12_000);

  it("cancels a waiting authorization", async () => {
    api.beginBrowserLogin.mockResolvedValue("flow-3");
    api.pollBrowserLogin.mockResolvedValue({ state: "waiting" });
    api.cancelBrowserLogin.mockResolvedValue();
    render(<ClaudeAccountsCard mode="code" />);
    await pickFromMenu(/^添加账号/, /从浏览器授权添加/);
    fireEvent.click(await screen.findByRole("button", { name: "取消授权" }));
    await waitFor(() =>
      expect(api.cancelBrowserLogin).toHaveBeenCalledWith("flow-3"),
    );
    await waitFor(() =>
      expect(screen.queryByText("在浏览器里授权 Claude 账号")).toBeNull(),
    );
  });

  it("ends a waiting authorization when the page is left", async () => {
    api.beginBrowserLogin.mockResolvedValue("flow-7");
    api.pollBrowserLogin.mockResolvedValue({ state: "waiting" });
    api.cancelBrowserLogin.mockResolvedValue();
    const { unmount } = render(<ClaudeAccountsCard mode="code" />);
    await pickFromMenu(/^添加账号/, /从浏览器授权添加/);
    await screen.findByText(/等待授权完成/);
    expect(api.cancelBrowserLogin).not.toHaveBeenCalled();
    unmount();
    await waitFor(() =>
      expect(api.cancelBrowserLogin).toHaveBeenCalledWith("flow-7"),
    );
  });

  it("tells a lost or crashed authorization apart from a failed one", async () => {
    api.beginBrowserLogin.mockResolvedValue("flow-8");
    api.pollBrowserLogin.mockResolvedValue({ state: "unknown" });
    render(<ClaudeAccountsCard mode="code" />);
    await pickFromMenu(/^添加账号/, /从浏览器授权添加/);
    expect(
      await screen.findByText(/这次授权已经结束，或应用被重启过/, undefined, {
        timeout: 6000,
      }),
    ).toBeInTheDocument();

    api.beginBrowserLogin.mockResolvedValue("flow-9");
    api.pollBrowserLogin.mockRejectedValue(new Error("IO 错误: 管道已断开"));
    fireEvent.click(
      await screen.findByRole("button", { name: /重试|重新开始/ }),
    );
    expect(
      await screen.findByText(/管道已断开/, undefined, { timeout: 6000 }),
    ).toBeInTheDocument();
  }, 15_000);

  it("shows a failed authorization and lets the user try again", async () => {
    api.beginBrowserLogin
      .mockResolvedValueOnce("flow-4")
      .mockResolvedValueOnce("flow-5");
    api.pollBrowserLogin.mockResolvedValue({
      state: "failed",
      message: "授权没有完成：没有拿到登录凭证。可能是授权页被关闭了，请重试。",
    });
    render(<ClaudeAccountsCard mode="code" />);
    await pickFromMenu(/^添加账号/, /从浏览器授权添加/);
    expect(
      await screen.findByText("浏览器授权没有完成", undefined, {
        timeout: 6000,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/没有拿到登录凭证/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新开始" }));
    await waitFor(() => expect(api.beginBrowserLogin).toHaveBeenCalledTimes(2));
  }, 12_000);

  it("explains a refused start, such as a missing claude command", async () => {
    api.beginBrowserLogin.mockRejectedValue(
      new Error(
        "没有找到 claude 命令。请先安装 Claude Code，并确认在终端里能运行 claude。",
      ),
    );
    render(<ClaudeAccountsCard mode="code" />);
    await pickFromMenu(/^添加账号/, /从浏览器授权添加/);
    expect(await screen.findByText(/没有找到 claude 命令/)).toBeInTheDocument();
    expect(api.pollBrowserLogin).not.toHaveBeenCalled();
  });
});

describe("ClaudeAccountsCard · tokens and API keys", () => {
  const TOKEN = "sk-ant-oat01-" + "B".repeat(40);
  const KEY = "sk-ant-api03-" + "A".repeat(40);

  async function openSecretDialog() {
    await pickFromMenu(/^添加账号/, /粘贴令牌或 API Key/);
    return screen.findByLabelText("令牌或密钥");
  }

  it("recognizes what was pasted and saves it with an optional name", async () => {
    const user = userEvent.setup();
    api.addSecret.mockResolvedValue({
      ...accounts.accounts[1],
      id: "tok",
      name: "CI",
      kind: "setup_token",
    });
    render(<ClaudeAccountsCard mode="code" />);
    const field = await openSecretDialog();
    const save = screen.getByRole("button", { name: "保存" });
    expect(save).toBeDisabled();
    expect(field).toHaveAttribute("type", "password");

    await user.type(field, "not-a-key");
    expect(screen.getByText(/无法识别：应以 sk-ant- 开头/)).toBeInTheDocument();
    expect(save).toBeDisabled();

    await user.clear(field);
    await user.type(field, "sk-ant-ort01-" + "C".repeat(30));
    expect(screen.getByText(/refresh token，不能单独添加/)).toBeInTheDocument();
    expect(save).toBeDisabled();

    await user.clear(field);
    await user.type(field, KEY);
    expect(screen.getByText(/Console API Key：按量计费/)).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, TOKEN);
    expect(screen.getByText(/setup-token：长期令牌/)).toBeInTheDocument();
    expect(save).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "显示" }));
    expect(field).toHaveAttribute("type", "text");
    await user.type(screen.getByLabelText("账号名称（可选）"), "CI");
    await user.click(save);
    await waitFor(() =>
      expect(api.addSecret).toHaveBeenCalledWith(TOKEN, "CI"),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "已添加「CI」",
        expect.anything(),
      ),
    );
    await waitFor(() => expect(api.listCode).toHaveBeenCalledTimes(2));
    expect(screen.queryByLabelText("令牌或密钥")).toBeNull();
  });

  it("keeps the dialog and shows the reason when the app refuses the value", async () => {
    const user = userEvent.setup();
    api.addSecret.mockRejectedValue(
      new Error("无效输入: 这个令牌已经保存过了"),
    );
    render(<ClaudeAccountsCard mode="code" />);
    const field = await openSecretDialog();
    await user.type(field, TOKEN);
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "这个令牌已经保存过了",
    );
    expect(screen.getByLabelText("令牌或密钥")).toHaveValue(TOKEN);
  });

  it("forgets what was typed when the dialog is closed without saving", async () => {
    const user = userEvent.setup();
    render(<ClaudeAccountsCard mode="code" />);
    const field = await openSecretDialog();
    await user.type(field, TOKEN);
    await user.type(screen.getByLabelText("账号名称（可选）"), "CI");
    await user.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("令牌或密钥")).toBeNull(),
    );
    const again = await openSecretDialog();
    expect(again).toHaveValue("");
    expect(screen.getByLabelText("账号名称（可选）")).toHaveValue("");
    expect(again).toHaveAttribute("type", "password");
  });

  it("shows a token or key as such, without a quota it cannot have", async () => {
    api.listCode.mockResolvedValue({
      ...structuredClone(accounts),
      accounts: [
        ...structuredClone(accounts.accounts),
        {
          ...accounts.accounts[1],
          id: "tok",
          name: "CI",
          email: null,
          plan: null,
          kind: "setup_token",
        },
        {
          ...accounts.accounts[1],
          id: "key",
          name: "控制台",
          email: null,
          plan: null,
          kind: "api_key",
        },
      ],
    });
    render(<ClaudeAccountsCard mode="code" />);
    const list = await screen.findByRole("list", {
      name: "已保存的 Claude Code 账号",
    });
    expect(within(list).getByText("setup-token")).toBeInTheDocument();
    expect(within(list).getByText("API Key")).toBeInTheDocument();
    expect(
      within(list).getByText("长期令牌，读不到订阅额度"),
    ).toBeInTheDocument();
    expect(
      within(list).getByText("按量计费的 API Key，没有订阅额度"),
    ).toBeInTheDocument();
    await waitFor(() => expect(api.codeQuota).toHaveBeenCalledTimes(2));
    expect(api.codeQuota).not.toHaveBeenCalledWith("tok", expect.anything());
    expect(api.codeQuota).not.toHaveBeenCalledWith("key", expect.anything());
    expect(screen.queryByRole("button", { name: "刷新 CI 的额度" })).toBeNull();
  });
});

describe("ClaudeAccountsCard · holding accounts out of use", () => {
  it("disables and enables an account from its menu, and says what that means", async () => {
    api.setDisabled.mockResolvedValue();
    render(<ClaudeAccountsCard mode="code" />);
    await pickFromMenu("个人 的更多操作", /^停用$/);
    await waitFor(() =>
      expect(api.setDisabled).toHaveBeenCalledWith("me", true),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "已停用「个人」",
        expect.objectContaining({
          description: expect.stringContaining("不会被切换"),
        }),
      ),
    );
  });

  it("shows a held-out account quietly: no switch, no session, no quota", async () => {
    api.listCode.mockResolvedValue({
      ...structuredClone(accounts),
      accounts: [
        structuredClone(accounts.accounts[0]),
        { ...structuredClone(accounts.accounts[1]), disabled: true },
      ],
    });
    api.setDisabled.mockResolvedValue();
    render(<ClaudeAccountsCard mode="code" />);
    const list = await screen.findByRole("list", {
      name: "已保存的 Claude Code 账号",
    });
    expect(within(list).getByText("已停用")).toBeInTheDocument();
    expect(within(list).getByText("已停用：不读取额度")).toBeInTheDocument();
    expect(
      within(list).queryByRole("button", { name: /切换到此账号/ }),
    ).toBeNull();
    expect(within(list).queryByRole("button", { name: /并行打开/ })).toBeNull();
    await waitFor(() => expect(api.codeQuota).toHaveBeenCalledTimes(1));
    expect(api.codeQuota).not.toHaveBeenCalledWith("me", expect.anything());

    await pickFromMenu("个人 的更多操作", /^启用$/);
    await waitFor(() =>
      expect(api.setDisabled).toHaveBeenCalledWith("me", false),
    );
  });

  it("does not offer to hold out the account in use", async () => {
    const user = userEvent.setup();
    render(<ClaudeAccountsCard mode="code" />);
    await user.click(
      await screen.findByRole("button", { name: "工作 的更多操作" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: /停用（正在使用/ }),
    ).toHaveAttribute("aria-disabled", "true");
  });
});

describe("ClaudeAccountsCard · parallel sessions and folders", () => {
  it("opens an account in its own terminal", async () => {
    api.openSession.mockResolvedValue({
      accountId: "me",
      accountName: "个人",
      dir: null,
      viaBinding: false,
      usesDefaultLogin: false,
      warnings: ["没有共享 skills：它是符号链接。"],
    });
    render(<ClaudeAccountsCard mode="code" />);
    fireEvent.click(
      await screen.findByRole("button", { name: "并行打开 个人" }),
    );
    await waitFor(() =>
      expect(api.openSession).toHaveBeenCalledWith({ id: "me" }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "已在新终端打开「个人」",
        expect.objectContaining({
          description: expect.stringMatching(
            /当前的登录不受影响.*没有共享 skills/,
          ),
        }),
      ),
    );
  });

  it("offers parallel sessions only where they can work", async () => {
    api.listCode.mockResolvedValue({
      ...structuredClone(accounts),
      sessionsSupported: false,
    });
    render(<ClaudeAccountsCard mode="code" />);
    await screen.findByRole("list", { name: "已保存的 Claude Code 账号" });
    expect(screen.queryByRole("button", { name: /并行打开/ })).toBeNull();
  });

  it("marks an account that has a terminal open", async () => {
    api.listCode.mockResolvedValue({
      ...structuredClone(accounts),
      accounts: [
        structuredClone(accounts.accounts[0]),
        { ...structuredClone(accounts.accounts[1]), sessionRunning: true },
      ],
    });
    render(<ClaudeAccountsCard mode="code" />);
    expect(await screen.findByText("会话中")).toBeInTheDocument();
  });

  it("copies the start command for the chosen shell", async () => {
    api.sessionCommands.mockResolvedValue({
      dir: "C:\\v\\sessions\\me",
      cmd: 'set "CLAUDE_CONFIG_DIR=C:\\v\\sessions\\me" && claude',
      powershell: "$env:CLAUDE_CONFIG_DIR = 'C:\\v\\sessions\\me'; claude",
    });
    render(<ClaudeAccountsCard mode="code" />);
    await pickFromMenu("个人 的更多操作", /复制启动命令（PowerShell）/);
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "已复制启动命令",
        expect.anything(),
      ),
    );
    expect(api.sessionCommands).toHaveBeenCalledWith("me");
    expect(await navigator.clipboard.readText()).toBe(
      "$env:CLAUDE_CONFIG_DIR = 'C:\\v\\sessions\\me'; claude",
    );
  });

  it("binds a folder picked in the system dialog and tells the folders card", async () => {
    const changed = vi.fn();
    window.addEventListener(BINDINGS_CHANGED_EVENT, changed);
    api.pickFolder.mockResolvedValue("D:\\work\\api");
    api.setBinding.mockResolvedValue({
      path: "D:\\work\\api",
      accountId: "me",
      accountName: "个人",
      accountEmail: "me@example.com",
      state: "ready",
      pathMissing: false,
    });
    render(<ClaudeAccountsCard mode="code" />);
    await pickFromMenu("个人 的更多操作", /绑定目录/);
    await waitFor(() =>
      expect(api.setBinding).toHaveBeenCalledWith("D:\\work\\api", "me"),
    );
    expect(changed).toHaveBeenCalled();
    window.removeEventListener(BINDINGS_CHANGED_EVENT, changed);
  });

  it("does nothing when the folder dialog is cancelled", async () => {
    api.pickFolder.mockResolvedValue(null);
    render(<ClaudeAccountsCard mode="code" />);
    await pickFromMenu("个人 的更多操作", /绑定目录/);
    await waitFor(() => expect(api.pickFolder).toHaveBeenCalled());
    expect(api.setBinding).not.toHaveBeenCalled();
  });
});

describe("ClaudeAccountsCard · order", () => {
  const three = () => ({
    ...structuredClone(accounts),
    accounts: [
      ...structuredClone(accounts.accounts),
      { ...structuredClone(accounts.accounts[1]), id: "third", name: "第三" },
    ],
  });
  const names = () =>
    Array.from(
      screen
        .getByRole("list", { name: "已保存的 Claude Code 账号" })
        .querySelectorAll(":scope > li"),
    ).map((row) => row.querySelector("strong")?.textContent);

  it("moves an account with the arrow keys on its grip and says where it went", async () => {
    const user = userEvent.setup();
    api.listCode.mockResolvedValue(three());
    render(<ClaudeAccountsCard mode="code" />);
    await screen.findByRole("list", { name: "已保存的 Claude Code 账号" });
    expect(names()).toEqual(["工作", "个人", "第三"]);

    const grip = screen.getByRole("button", { name: /移动 个人/ });
    grip.focus();
    await user.keyboard("{ArrowDown}");
    expect(names()).toEqual(["工作", "第三", "个人"]);
    await waitFor(() =>
      expect(api.reorder).toHaveBeenCalledWith(["work", "third", "me"]),
    );
    expect(
      screen.getByText("已把「个人」移到第 3 位，共 3 个"),
    ).toBeInTheDocument();

    // The keyboard stays on the grip of the row that moved.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /移动 个人/ })).toHaveFocus(),
    );

    // The first one cannot go further up.
    api.reorder.mockClear();
    screen.getByRole("button", { name: /移动 工作/ }).focus();
    await user.keyboard("{ArrowUp}");
    expect(api.reorder).not.toHaveBeenCalled();
  });

  it("reorders by dragging the grip onto another row", async () => {
    api.listCode.mockResolvedValue(three());
    render(<ClaudeAccountsCard mode="code" />);
    await screen.findByRole("list", { name: "已保存的 Claude Code 账号" });
    const transfer = {
      setData: vi.fn(),
      setDragImage: vi.fn(),
      effectAllowed: "",
      dropEffect: "",
    };
    const grip = screen.getByRole("button", { name: /移动 第三/ });
    const firstRow = screen.getByText("工作").closest("li") as HTMLElement;
    fireEvent.dragStart(grip, { dataTransfer: transfer });
    fireEvent.dragOver(firstRow, { dataTransfer: transfer });
    fireEvent.drop(firstRow, { dataTransfer: transfer });
    expect(names()).toEqual(["第三", "工作", "个人"]);
    await waitFor(() =>
      expect(api.reorder).toHaveBeenCalledWith(["third", "work", "me"]),
    );
  });

  it("moves a row up or down from its menu, for those who cannot drag", async () => {
    const user = userEvent.setup();
    api.listCode.mockResolvedValue(three());
    render(<ClaudeAccountsCard mode="code" />);
    await screen.findByRole("list", { name: "已保存的 Claude Code 账号" });
    await user.click(screen.getByRole("button", { name: "个人 的更多操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "下移" }));
    expect(names()).toEqual(["工作", "第三", "个人"]);
    await waitFor(() =>
      expect(api.reorder).toHaveBeenCalledWith(["work", "third", "me"]),
    );
    // The first row cannot go up, nor the last one down.
    await user.click(screen.getByRole("button", { name: "工作 的更多操作" }));
    expect(
      await screen.findByRole("menuitem", { name: "上移" }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("keeps the newest order when moves come one after another", async () => {
    const user = userEvent.setup();
    api.listCode.mockResolvedValue(three());
    const finished: string[] = [];
    let release: (() => void) | undefined;
    api.reorder
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = () => {
              finished.push("first");
              resolve();
            };
          }),
      )
      .mockImplementationOnce(async () => {
        finished.push("second");
      });
    render(<ClaudeAccountsCard mode="code" />);
    await screen.findByRole("list", { name: "已保存的 Claude Code 账号" });
    const grip = screen.getByRole("button", { name: /移动 个人/ });
    grip.focus();
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(api.reorder).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /移动 个人/ })).toHaveFocus(),
    );
    await user.keyboard("{ArrowUp}");
    // The second save waits for the first one.
    expect(api.reorder).toHaveBeenCalledTimes(1);
    release?.();
    await waitFor(() => expect(api.reorder).toHaveBeenCalledTimes(2));
    expect(finished).toEqual(["first", "second"]);
  });

  it("reloads the real order when saving it fails", async () => {
    const user = userEvent.setup();
    api.listCode.mockResolvedValue(three());
    api.reorder.mockRejectedValue(new Error("IO 错误: 拒绝访问"));
    render(<ClaudeAccountsCard mode="code" />);
    await screen.findByRole("list", { name: "已保存的 Claude Code 账号" });
    screen.getByRole("button", { name: /移动 个人/ }).focus();
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() => expect(api.listCode).toHaveBeenCalledTimes(2));
  });

  it("has no grips when there is only one account", async () => {
    api.listCode.mockResolvedValue({
      ...structuredClone(accounts),
      accounts: [structuredClone(accounts.accounts[0])],
    });
    render(<ClaudeAccountsCard mode="code" />);
    await screen.findByRole("list", { name: "已保存的 Claude Code 账号" });
    expect(screen.queryByRole("button", { name: /移动 / })).toBeNull();
  });
});

describe("ClaudeAccountsCard · the default Claude Desktop", () => {
  const swapStatus = (over: Partial<ClaudeDesktopSwapStatus> = {}) => ({
    supported: true,
    running: false,
    signedIn: true,
    accountUuid: "uuid-me",
    currentAccountId: "me",
    snapshots: [],
    ...over,
  });
  const outcome = (over: Partial<ClaudeDesktopSwapOutcome> = {}) => ({
    status: "done" as const,
    wasRunning: false,
    restarted: false,
    savedOutgoingFor: null,
    stashedOutgoing: false,
    ...over,
  });

  it("offers to save the sign-in of the account Desktop is signed in as", async () => {
    api.desktopSwapStatus.mockResolvedValue(swapStatus());
    api.captureDesktopLogin.mockResolvedValue(outcome());
    render(<ClaudeAccountsCard mode="desktop" />);
    expect(
      await screen.findByText(
        /登录的是已保存的账号「个人」，还没有保存它的 Desktop 登录/,
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      within(
        screen.getByRole("list", { name: "Claude Desktop 账号" }),
      ).getByRole("button", { name: "保存 Desktop 登录" }),
    );
    await waitFor(() =>
      expect(api.captureDesktopLogin).toHaveBeenCalledWith("me", false),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "已保存默认 Claude Desktop 的登录，属于「个人」",
        expect.anything(),
      ),
    );
  });

  it("explains an account that is not saved yet instead of guessing", async () => {
    api.desktopSwapStatus.mockResolvedValue(
      swapStatus({ currentAccountId: null, accountUuid: "uuid-stranger" }),
    );
    render(<ClaudeAccountsCard mode="desktop" />);
    expect(
      await screen.findByText(/登录的账号不在已保存的账号里/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "保存 Desktop 登录" }),
    ).toBeNull();
  });

  it("switches the default Desktop to an account that has a saved sign-in", async () => {
    api.desktopSwapStatus.mockResolvedValue(
      swapStatus({
        snapshots: [
          { accountId: "work", capturedAt: "2026-11-04", isCurrent: false },
          { accountId: "me", capturedAt: "2026-11-04", isCurrent: true },
        ],
      }),
    );
    api.switchDesktop.mockResolvedValue(
      outcome({ restarted: true, savedOutgoingFor: "me" }),
    );
    render(<ClaudeAccountsCard mode="desktop" />);
    const list = await screen.findByRole("list", {
      name: "已保存的 Claude 登录列表",
    });
    expect(within(list).getByText("默认 Desktop 在用")).toBeInTheDocument();
    expect(
      within(list).getAllByRole("button", { name: /切换默认 Desktop/ }),
    ).toHaveLength(1);
    fireEvent.click(
      within(list).getByRole("button", { name: /切换默认 Desktop/ }),
    );
    await waitFor(() =>
      expect(api.switchDesktop).toHaveBeenCalledWith("work", false),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "默认 Claude Desktop 已切换到「工作」",
        expect.objectContaining({
          description: expect.stringContaining("已重新打开"),
        }),
      ),
    );
  });

  it("asks before closing a running Desktop, then does it", async () => {
    api.desktopSwapStatus.mockResolvedValue(
      swapStatus({
        running: true,
        snapshots: [
          { accountId: "work", capturedAt: "2026-11-04", isCurrent: false },
        ],
      }),
    );
    api.switchDesktop
      .mockResolvedValueOnce(outcome({ status: "desktop_running" }))
      .mockResolvedValueOnce(outcome({ wasRunning: true, restarted: true }));
    render(<ClaudeAccountsCard mode="desktop" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /切换默认 Desktop/ }),
    );
    expect(
      await screen.findByText("需要先关闭 Claude Desktop"),
    ).toBeInTheDocument();
    expect(api.switchDesktop).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "关闭并继续" }));
    await waitFor(() =>
      expect(api.switchDesktop).toHaveBeenLastCalledWith("work", true),
    );
    await waitFor(() =>
      expect(screen.queryByText("需要先关闭 Claude Desktop")).toBeNull(),
    );
  });

  it("takes Desktop back to its sign-in page for a login with no Desktop sign-in yet", async () => {
    api.desktopSwapStatus.mockResolvedValue(swapStatus());
    api.prepareDesktopLogin.mockResolvedValue(
      outcome({ restarted: true, savedOutgoingFor: "me" }),
    );
    render(<ClaudeAccountsCard mode="desktop" />);
    const list = await screen.findByRole("list", {
      name: "已保存的 Claude 登录列表",
    });
    // The login Desktop is signed in as is saved; the other one is prepared.
    expect(
      within(list).getByRole("button", { name: /保存 Desktop 登录 个人/ }),
    ).toBeInTheDocument();
    fireEvent.click(
      within(list).getByRole("button", { name: /用此账号登录 Desktop 工作/ }),
    );
    await waitFor(() =>
      expect(api.prepareDesktopLogin).toHaveBeenCalledWith("work", false),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "默认 Claude Desktop 已回到登录页",
        expect.objectContaining({
          description: expect.stringContaining("保存 Desktop 登录"),
        }),
      ),
    );
  });

  it("asks before closing a running Desktop to go back to its sign-in page", async () => {
    api.desktopSwapStatus.mockResolvedValue(swapStatus({ running: true }));
    api.prepareDesktopLogin
      .mockResolvedValueOnce(outcome({ status: "desktop_running" }))
      .mockResolvedValueOnce(outcome({ wasRunning: true, restarted: true }));
    render(<ClaudeAccountsCard mode="desktop" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /用此账号登录 Desktop 工作/ }),
    );
    expect(
      await screen.findByText(/不会被退出，之后还能切换回来/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭并继续" }));
    await waitFor(() =>
      expect(api.prepareDesktopLogin).toHaveBeenLastCalledWith("work", true),
    );
  });

  it("says so when Desktop was closed and could not be opened again", async () => {
    api.desktopSwapStatus.mockResolvedValue(
      swapStatus({
        snapshots: [
          { accountId: "work", capturedAt: "2026-11-04", isCurrent: false },
        ],
      }),
    );
    api.switchDesktop.mockResolvedValue(
      outcome({ wasRunning: true, restarted: false }),
    );
    render(<ClaudeAccountsCard mode="desktop" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /切换默认 Desktop/ }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "默认 Claude Desktop 已切换到「工作」",
        expect.objectContaining({
          description: expect.stringContaining("请手动打开"),
        }),
      ),
    );
  });

  it("names what closing Desktop ends, and drops the question when the swap fails", async () => {
    api.desktopSwapStatus.mockResolvedValue(
      swapStatus({
        running: true,
        snapshots: [
          { accountId: "work", capturedAt: "2026-11-04", isCurrent: false },
        ],
      }),
    );
    api.switchDesktop
      .mockResolvedValueOnce(outcome({ status: "desktop_running" }))
      .mockRejectedValueOnce(new Error("登录文件被占用"));
    render(<ClaudeAccountsCard mode="desktop" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /切换默认 Desktop/ }),
    );
    expect(
      await screen.findByText(/Claude Code 会话、定时任务和 MCP 服务/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭并继续" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("登录文件被占用"),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText("需要先关闭 Claude Desktop")).toBeNull(),
    );
  });

  it("offers no Desktop switching where it is not supported", async () => {
    api.desktopSwapStatus.mockResolvedValue(swapStatus({ supported: false }));
    render(<ClaudeAccountsCard mode="desktop" />);
    await screen.findByRole("list", { name: "已保存的 Claude 登录列表" });
    expect(
      screen.queryByRole("button", { name: /切换默认 Desktop/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "保存 Desktop 登录" }),
    ).toBeNull();
  });
});

describe("ClaudeAccountsCard · saved logins on the Claude Desktop page", () => {
  it("lists them with quota but without switching, and offers the same add menu", async () => {
    const user = userEvent.setup();
    render(<ClaudeAccountsCard mode="desktop" />);
    const list = await screen.findByRole("list", {
      name: "已保存的 Claude 登录列表",
    });
    expect(within(list).getByText("work@example.com")).toBeInTheDocument();
    expect(within(list).getByText("me@example.com")).toBeInTheDocument();
    // Claude Desktop cannot switch to a saved login the way Claude Code does.
    expect(within(list).queryByText("切换到此账号")).toBeNull();
    expect(within(list).queryByText("使用中")).toBeNull();
    await waitFor(() =>
      expect(api.codeQuota).toHaveBeenCalledWith("me", false),
    );
    await user.click(screen.getByRole("button", { name: /^添加登录/ }));
    expect(
      await screen.findByRole("menuitem", { name: /导入凭证文件/ }),
    ).toBeVisible();
    // A token or a key, and signing in from a terminal, are Claude Code things.
    expect(
      screen.queryByRole("menuitem", { name: /粘贴令牌或 API Key/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: /在终端登录后保存/ }),
    ).toBeNull();
  });

  it("renames and deletes a saved login from its menu", async () => {
    api.renameCode.mockResolvedValue();
    api.deleteCode.mockResolvedValue();
    render(<ClaudeAccountsCard mode="desktop" />);
    await pickFromMenu("个人 的更多操作", /^重命名$/);
    fireEvent.change(await screen.findByLabelText("账号名称"), {
      target: { value: "备用" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await waitFor(() =>
      expect(api.renameCode).toHaveBeenCalledWith("me", "备用"),
    );
    expect(api.renameDesktop).not.toHaveBeenCalled();

    await pickFromMenu("个人 的更多操作", /^删除$/);
    expect(
      await screen.findByText(
        /只删除 Chimera 保存的这份登录（me@example.com）/,
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(api.deleteCode).toHaveBeenCalledWith("me"));
    expect(api.deleteDesktop).not.toHaveBeenCalled();
  });

  it("leaves the page usable when the saved logins cannot be listed", async () => {
    api.listCode.mockRejectedValue(new Error("IO 错误: 拒绝访问"));
    render(<ClaudeAccountsCard mode="desktop" />);
    expect(await screen.findByText("默认账号")).toBeInTheDocument();
    await waitFor(() => expect(api.listCode).toHaveBeenCalled());
    expect(screen.queryByText("已保存的 Claude 登录")).toBeNull();
  });
});

describe("helpers", () => {
  it("formats countdowns and strips the generic error prefix", () => {
    const now = new Date(2026, 9, 30, 16, 27).getTime();
    expect(resetText(new Date(2026, 9, 30, 18, 40).toISOString(), now)).toBe(
      "2 小时 13 分后重置 · 18:40",
    );
    expect(resetText(new Date(2026, 10, 2, 8, 0).toISOString(), now)).toBe(
      "2 天 15 小时后重置 · 11月2日 08:00",
    );
    expect(resetText(null, now)).toBe("重置时间未知");
    expect(errorText("无效输入: 账号标识无效")).toBe("账号标识无效");
  });
});
