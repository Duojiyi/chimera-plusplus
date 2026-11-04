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
  ClaudeBindingsCard,
  folderName,
} from "@/components/claude-accounts/ClaudeBindingsCard";
import { BINDINGS_CHANGED_EVENT } from "@/components/claude-accounts/ClaudeAccountsCard";
import {
  claudeAccountsApi,
  type ClaudeBinding,
  type ClaudeCodeAccount,
} from "@/lib/api/claudeAccounts";

vi.mock("@/lib/api/claudeAccounts", () => ({
  claudeAccountsApi: {
    listBindings: vi.fn(),
    listCode: vi.fn(),
    setBinding: vi.fn(),
    removeBinding: vi.fn(),
    pickFolder: vi.fn(),
    openSession: vi.fn(),
  },
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const api = vi.mocked(claudeAccountsApi);

const account = (over: Partial<ClaudeCodeAccount>): ClaudeCodeAccount => ({
  id: "work",
  name: "工作",
  email: "work@example.com",
  plan: "Max",
  fingerprint: "abcd1234",
  createdAt: "2026-10-01",
  updatedAt: "2026-10-01",
  isCurrent: false,
  needsRelogin: false,
  unreadable: false,
  kind: "oauth",
  disabled: false,
  sessionRunning: false,
  ...over,
});

const binding = (over: Partial<ClaudeBinding> = {}): ClaudeBinding => ({
  path: "D:\\work\\api",
  accountId: "work",
  accountName: "工作",
  accountEmail: "work@example.com",
  state: "ready",
  pathMissing: false,
  ...over,
});

function listing(accounts: ClaudeCodeAccount[], sessionsSupported = true) {
  api.listCode.mockResolvedValue({
    supported: true,
    unsupportedReason: null,
    browserLoginSupported: true,
    sessionsSupported,
    live: { signedIn: false },
    accounts,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  listing([
    account({}),
    account({ id: "me", name: "个人", email: "me@example.com" }),
  ]);
  api.listBindings.mockResolvedValue([]);
});

describe("ClaudeBindingsCard", () => {
  it("names a folder by its last part", () => {
    expect(folderName("D:\\work\\api")).toBe("api");
    expect(folderName("D:\\work\\api\\")).toBe("api");
    expect(folderName("/home/me/app")).toBe("app");
    expect(folderName("D:\\")).toBe("D:");
  });

  it("explains itself when nothing is bound", async () => {
    render(<ClaudeBindingsCard />);
    expect(await screen.findByText(/还没有绑定的目录/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /绑定目录/ })).toBeEnabled();
  });

  it("lists bound folders with their account and opens Claude there", async () => {
    api.listBindings.mockResolvedValue([binding()]);
    api.openSession.mockResolvedValue({
      accountId: "work",
      accountName: "工作",
      dir: "D:\\work\\api",
      viaBinding: true,
      usesDefaultLogin: false,
    });
    render(<ClaudeBindingsCard />);
    const list = await screen.findByRole("list", { name: "已绑定的目录" });
    expect(within(list).getByText("api")).toBeInTheDocument();
    expect(within(list).getByText("D:\\work\\api")).toBeInTheDocument();
    expect(
      within(list).getByRole("combobox", { name: "api 使用的账号" }),
    ).toHaveValue("work");
    fireEvent.click(
      within(list).getByRole("button", { name: "在 api 打开 Claude" }),
    );
    await waitFor(() =>
      expect(api.openSession).toHaveBeenCalledWith({ dir: "D:\\work\\api" }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "已用「工作」在 api 打开 Claude",
        expect.anything(),
      ),
    );
  });

  it("binds a folder: pick it, choose the account, confirm", async () => {
    api.pickFolder.mockResolvedValue("D:\\work\\web");
    api.setBinding.mockResolvedValue(
      binding({ path: "D:\\work\\web", accountId: "me" }),
    );
    render(<ClaudeBindingsCard />);
    fireEvent.click(await screen.findByRole("button", { name: /绑定目录/ }));
    expect(await screen.findByText("D:\\work\\web")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("使用的账号"), {
      target: { value: "me" },
    });
    fireEvent.click(screen.getByRole("button", { name: "绑定" }));
    await waitFor(() =>
      expect(api.setBinding).toHaveBeenCalledWith("D:\\work\\web", "me"),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("已绑定 web"),
    );
  });

  it("does nothing when the folder dialog is cancelled", async () => {
    api.pickFolder.mockResolvedValue(null);
    render(<ClaudeBindingsCard />);
    fireEvent.click(await screen.findByRole("button", { name: /绑定目录/ }));
    await waitFor(() => expect(api.pickFolder).toHaveBeenCalled());
    expect(screen.queryByText("使用的账号")).toBeNull();
    expect(api.setBinding).not.toHaveBeenCalled();
  });

  it("changes and removes a binding", async () => {
    api.listBindings.mockResolvedValue([binding()]);
    api.setBinding.mockResolvedValue(binding({ accountId: "me" }));
    api.removeBinding.mockResolvedValue();
    render(<ClaudeBindingsCard />);
    fireEvent.change(
      await screen.findByRole("combobox", { name: "api 使用的账号" }),
      {
        target: { value: "me" },
      },
    );
    await waitFor(() =>
      expect(api.setBinding).toHaveBeenCalledWith("D:\\work\\api", "me"),
    );
    fireEvent.click(screen.getByRole("button", { name: "解除 api 的绑定" }));
    await waitFor(() =>
      expect(api.removeBinding).toHaveBeenCalledWith("D:\\work\\api"),
    );
  });

  it("says when the account is gone, held out of use, or the folder is missing", async () => {
    api.listBindings.mockResolvedValue([
      binding({ path: "D:\\a", state: "missing", accountName: null }),
      binding({ path: "D:\\b", state: "disabled" }),
      binding({ path: "D:\\c", pathMissing: true }),
    ]);
    render(<ClaudeBindingsCard />);
    const list = await screen.findByRole("list", { name: "已绑定的目录" });
    expect(within(list).getByText("账号已删除")).toBeInTheDocument();
    expect(within(list).getByText("账号已停用")).toBeInTheDocument();
    expect(within(list).getByText("目录不存在")).toBeInTheDocument();
    const open = within(list).getAllByRole("button", { name: /打开 Claude/ });
    expect(open).toHaveLength(3);
    for (const button of open) expect(button).toBeDisabled();
  });

  it("reloads when an account row binds a folder", async () => {
    render(<ClaudeBindingsCard />);
    await screen.findByText(/还没有绑定的目录/);
    api.listBindings.mockResolvedValue([binding()]);
    window.dispatchEvent(new CustomEvent(BINDINGS_CHANGED_EVENT));
    expect(
      await screen.findByRole("list", { name: "已绑定的目录" }),
    ).toBeInTheDocument();
  });

  it("opens a picked folder with whatever account it resolves to", async () => {
    api.pickFolder.mockResolvedValue("D:\\work\\api\\v1");
    api.openSession.mockResolvedValue({
      accountId: "work",
      accountName: "工作",
      dir: "D:\\work\\api\\v1",
      viaBinding: true,
      usesDefaultLogin: false,
    });
    render(<ClaudeBindingsCard />);
    fireEvent.click(
      await screen.findByRole("button", { name: /选择目录并打开 Claude/ }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "已按目录绑定，用「工作」打开 Claude",
        expect.anything(),
      ),
    );
  });

  it("offers no opening where parallel sessions are not supported", async () => {
    listing([account({})], false);
    api.listBindings.mockResolvedValue([binding()]);
    render(<ClaudeBindingsCard />);
    await screen.findByRole("list", { name: "已绑定的目录" });
    expect(screen.queryByRole("button", { name: /打开 Claude/ })).toBeNull();
  });

  it("will not start a binding with no usable account", async () => {
    listing([account({ disabled: true })]);
    render(<ClaudeBindingsCard />);
    expect(
      await screen.findByRole("button", { name: /绑定目录/ }),
    ).toBeDisabled();
  });

  it("can be folded away and remembers it", async () => {
    api.listBindings.mockResolvedValue([binding()]);
    const { unmount } = render(<ClaudeBindingsCard />);
    expect(
      await screen.findByRole("list", { name: "已绑定的目录" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /收起目录绑定/ }));
    expect(screen.queryByRole("list", { name: "已绑定的目录" })).toBeNull();
    expect(screen.queryByRole("button", { name: /绑定目录/ })).toBeNull();
    unmount();
    render(<ClaudeBindingsCard />);
    expect(
      screen.getByRole("button", { name: /展开目录绑定/ }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("shows why it could not read the bindings", async () => {
    api.listBindings.mockRejectedValue(new Error("目录绑定文件已损坏"));
    render(<ClaudeBindingsCard />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "目录绑定文件已损坏",
    );
  });
});
