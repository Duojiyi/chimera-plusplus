import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  ClaudeAccountsCard,
  errorText,
  resetText,
} from "@/components/claude-accounts/ClaudeAccountsCard";
import {
  claudeAccountsApi,
  type ClaudeCodeAccounts,
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
    fireEvent.click(await screen.findByRole("button", { name: /登录新账号/ }));
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
    fireEvent.click(await screen.findByRole("button", { name: "删除 个人" }));
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
    fireEvent.click(await screen.findByRole("button", { name: /登录新账号/ }));
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
    fireEvent.click(screen.getByRole("button", { name: /添加账号/ }));
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
    fireEvent.click(await screen.findByRole("button", { name: /添加账号/ }));
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

describe("ClaudeAccountsCard · login files and browser authorization", () => {
  const savedAccount = {
    ...accounts.accounts[1],
    id: "new",
    name: "new@example.com",
    email: "new@example.com",
  };

  it("offers authorization, import and export on both pages", async () => {
    render(<ClaudeAccountsCard mode="code" />);
    expect(
      await screen.findByRole("button", { name: /从浏览器授权添加/ }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: /导入凭证文件/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /导出凭证文件/ })).toBeEnabled();
  });

  it("hides browser authorization where the app cannot start it", async () => {
    api.listCode.mockResolvedValue({
      ...structuredClone(accounts),
      browserLoginSupported: false,
    });
    render(<ClaudeAccountsCard mode="code" />);
    expect(
      await screen.findByRole("button", { name: /导入凭证文件/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /从浏览器授权添加/ }),
    ).toBeNull();
  });

  it("has no login-file tools where saved logins are unsupported", async () => {
    api.listCode.mockResolvedValue({
      ...structuredClone(accounts),
      supported: false,
      unsupportedReason: "macOS 上暂不支持",
      accounts: [],
    });
    render(<ClaudeAccountsCard mode="code" />);
    expect(await screen.findByText("macOS 上暂不支持")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /导入凭证文件/ })).toBeNull();
  });

  it("warns that the export is plaintext before it opens the save dialog", async () => {
    api.exportLogins.mockResolvedValue({
      path: "D:/backup/chimera-claude-logins.json",
      count: 2,
      skipped: 0,
    });
    render(<ClaudeAccountsCard mode="code" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /导出凭证文件/ }),
    );
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
    fireEvent.click(
      await screen.findByRole("button", { name: /导出凭证文件/ }),
    );
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
    api.listCode.mockResolvedValue({
      ...structuredClone(accounts),
      accounts: [],
    });
    render(<ClaudeAccountsCard mode="code" />);
    expect(
      await screen.findByRole("button", { name: /导出凭证文件/ }),
    ).toBeDisabled();
  });

  it("reports what an import added, updated and skipped, and reloads", async () => {
    api.importLogins.mockResolvedValue({
      imported: [savedAccount],
      updated: [{ ...accounts.accounts[0], name: "工作" }],
      skipped: [{ email: "me@example.com", reason: "已经保存了相同的登录" }],
    });
    render(<ClaudeAccountsCard mode="code" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /导入凭证文件/ }),
    );
    expect(await screen.findByText("导入完成")).toBeInTheDocument();
    expect(
      screen.getByText("新增 1 个，更新 1 个，跳过 1 个。"),
    ).toBeInTheDocument();
    expect(screen.getByText("已经保存了相同的登录")).toBeInTheDocument();
    await waitFor(() => expect(api.listCode).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    await waitFor(() => expect(screen.queryByText("导入完成")).toBeNull());
  });

  it("does not reload when the import dialog is cancelled or nothing was added", async () => {
    api.importLogins.mockResolvedValueOnce(null);
    render(<ClaudeAccountsCard mode="code" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /导入凭证文件/ }),
    );
    await waitFor(() => expect(api.importLogins).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("导入完成")).toBeNull();

    api.importLogins.mockResolvedValueOnce({
      imported: [],
      updated: [],
      skipped: [{ email: null, reason: "文件里重复出现的同一账号" }],
    });
    fireEvent.click(screen.getByRole("button", { name: /导入凭证文件/ }));
    expect(await screen.findByText("导入完成")).toBeInTheDocument();
    expect(screen.getByText("未识别的账号")).toBeInTheDocument();
    expect(api.listCode).toHaveBeenCalledTimes(1);
  });

  it("shows why an import was refused", async () => {
    api.importLogins.mockRejectedValue(
      new Error("无效输入: 这个文件是加密的，请先解密再导入"),
    );
    render(<ClaudeAccountsCard mode="code" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /导入凭证文件/ }),
    );
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
    fireEvent.click(
      await screen.findByRole("button", { name: /从浏览器授权添加/ }),
    );
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
  }, 10_000);

  it("says when the authorization refreshed an account that was already saved", async () => {
    api.beginBrowserLogin.mockResolvedValue("flow-2");
    api.pollBrowserLogin.mockResolvedValue({
      state: "done",
      account: accounts.accounts[0],
      created: false,
    });
    render(<ClaudeAccountsCard mode="code" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /从浏览器授权添加/ }),
    );
    await waitFor(
      () =>
        expect(toast.success).toHaveBeenCalledWith(
          "「工作」已更新为刚授权的登录",
          expect.anything(),
        ),
      { timeout: 6000 },
    );
  }, 10_000);

  it("cancels a waiting authorization", async () => {
    api.beginBrowserLogin.mockResolvedValue("flow-3");
    api.pollBrowserLogin.mockResolvedValue({ state: "waiting" });
    api.cancelBrowserLogin.mockResolvedValue();
    render(<ClaudeAccountsCard mode="code" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /从浏览器授权添加/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "取消授权" }));
    await waitFor(() =>
      expect(api.cancelBrowserLogin).toHaveBeenCalledWith("flow-3"),
    );
    await waitFor(() =>
      expect(screen.queryByText("在浏览器里授权 Claude 账号")).toBeNull(),
    );
  });

  it("shows a failed authorization and lets the user try again", async () => {
    api.beginBrowserLogin
      .mockResolvedValueOnce("flow-4")
      .mockResolvedValueOnce("flow-5");
    api.pollBrowserLogin.mockResolvedValue({
      state: "failed",
      message: "授权没有完成：没有拿到登录凭证。可能是授权页被关闭了，请重试。",
    });
    render(<ClaudeAccountsCard mode="code" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /从浏览器授权添加/ }),
    );
    expect(
      await screen.findByText("浏览器授权没有完成", undefined, {
        timeout: 6000,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/没有拿到登录凭证/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新开始" }));
    await waitFor(() => expect(api.beginBrowserLogin).toHaveBeenCalledTimes(2));
  }, 10_000);

  it("explains a refused start, such as a missing claude command", async () => {
    api.beginBrowserLogin.mockRejectedValue(
      new Error(
        "没有找到 claude 命令。请先安装 Claude Code，并确认在终端里能运行 claude。",
      ),
    );
    render(<ClaudeAccountsCard mode="code" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /从浏览器授权添加/ }),
    );
    expect(await screen.findByText(/没有找到 claude 命令/)).toBeInTheDocument();
    expect(api.pollBrowserLogin).not.toHaveBeenCalled();
  });

  it("lists the saved logins on the Claude Desktop page, with the same tools", async () => {
    render(<ClaudeAccountsCard mode="desktop" />);
    const list = await screen.findByRole("list", {
      name: "已保存的 Claude 登录列表",
    });
    expect(within(list).getByText("work@example.com")).toBeInTheDocument();
    expect(within(list).getByText("me@example.com")).toBeInTheDocument();
    // Claude Desktop cannot switch to a saved login.
    expect(within(list).queryByText("切换到此账号")).toBeNull();
    expect(within(list).queryByText("使用中")).toBeNull();
    await waitFor(() =>
      expect(api.codeQuota).toHaveBeenCalledWith("me", false),
    );
    expect(
      screen.getByRole("button", { name: /从浏览器授权添加/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /导出凭证文件/ })).toBeEnabled();
  });

  it("renames and deletes a saved login from the Claude Desktop page", async () => {
    api.renameCode.mockResolvedValue();
    api.deleteCode.mockResolvedValue();
    render(<ClaudeAccountsCard mode="desktop" />);
    fireEvent.click(await screen.findByRole("button", { name: "重命名 个人" }));
    fireEvent.change(await screen.findByLabelText("账号名称"), {
      target: { value: "备用" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await waitFor(() =>
      expect(api.renameCode).toHaveBeenCalledWith("me", "备用"),
    );
    expect(api.renameDesktop).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole("button", { name: "删除 个人" }));
    expect(
      await screen.findByText(
        /只删除 Chimera 保存的这份登录（me@example.com）/,
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(api.deleteCode).toHaveBeenCalledWith("me"));
    expect(api.deleteDesktop).not.toHaveBeenCalled();
  });

  it("leaves the Claude Desktop page usable when the saved logins cannot be listed", async () => {
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
