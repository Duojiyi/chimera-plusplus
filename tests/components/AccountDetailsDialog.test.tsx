import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountDetailsDialog,
  parseTags,
} from "@/components/official-accounts/AccountDetailsDialog";
import {
  officialAccountsApi,
  type OfficialAccountDto,
} from "@/lib/api/officialAccounts";

vi.mock("@/lib/api/officialAccounts", () => ({
  officialAccountsApi: {
    listGroups: vi.fn(),
    createGroup: vi.fn(),
    deleteGroup: vi.fn(),
    setGroup: vi.fn(),
    setTags: vi.fn(),
    setNote: vi.fn(),
    setDisabled: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const api = vi.mocked(officialAccountsApi);

const account: OfficialAccountDto = {
  key: "acct-1",
  accountId: "a1",
  displayName: "alpha@studio.dev",
  capturedAt: "2026-11-01T00:00:00Z",
  isCurrent: false,
  needsRelogin: false,
  tags: ["主力"],
  groupId: "g1",
  note: "公司账号",
  disabled: false,
};

describe("parseTags", () => {
  it("splits on commas, 、 and spaces and drops a leading #", () => {
    expect(parseTags("主力，工作、 #备用  ,x")).toEqual([
      "主力",
      "工作",
      "备用",
      "x",
    ]);
  });
});

describe("AccountDetailsDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listGroups.mockResolvedValue([
      { id: "g1", name: "工作", sortIndex: 0, accountCount: 2 },
    ]);
    api.createGroup.mockResolvedValue({
      id: "g2",
      name: "新组",
      sortIndex: 1,
      accountCount: 0,
    });
  });

  it("writes only what changed, creating a new group when asked", async () => {
    const onSaved = vi.fn();
    render(
      <AccountDetailsDialog
        account={account}
        title="alpha"
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await screen.findByRole("option", { name: "工作（2）" });
    fireEvent.change(screen.getByLabelText("分组"), {
      target: { value: "__new__" },
    });
    fireEvent.change(screen.getByLabelText("新分组名称"), {
      target: { value: "新组" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.setNote).not.toHaveBeenCalled();
    expect(api.setTags).not.toHaveBeenCalled();
    expect(api.createGroup).toHaveBeenCalledWith("新组");
    expect(api.setGroup).toHaveBeenCalledWith("acct-1", "g2");
    expect(api.setDisabled).toHaveBeenCalledWith("acct-1", true);
  });

  it("does not let the account Codex is using be held out of use", async () => {
    render(
      <AccountDetailsDialog
        account={account}
        title="alpha"
        inUse
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await screen.findByRole("option", { name: "工作（2）" });
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByText(/先切换到别的账号再停用/)).toBeInTheDocument();
  });

  it("deletes the selected group after a second click, and reloads the list", async () => {
    api.deleteGroup.mockResolvedValue(2);
    const onSaved = vi.fn();
    render(
      <AccountDetailsDialog
        account={account}
        title="alpha"
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await screen.findByRole("option", { name: "工作（2）" });
    fireEvent.click(screen.getByRole("button", { name: "删除这个分组…" }));
    expect(api.deleteGroup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "删除分组" }));
    await waitFor(() => expect(api.deleteGroup).toHaveBeenCalledWith("g1"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(screen.getByLabelText("分组")).toHaveValue("");
  });

  it("reloads the list when a later field fails, and does not make the new group twice", async () => {
    api.setGroup.mockRejectedValueOnce(new Error("boom"));
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(
      <AccountDetailsDialog
        account={account}
        title="alpha"
        onClose={onClose}
        onSaved={onSaved}
      />,
    );
    await screen.findByRole("option", { name: "工作（2）" });
    fireEvent.change(screen.getByLabelText("分组"), {
      target: { value: "__new__" },
    });
    fireEvent.change(screen.getByLabelText("新分组名称"), {
      target: { value: "新组" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.createGroup).toHaveBeenCalledTimes(1);
    expect(api.setGroup).toHaveBeenLastCalledWith("acct-1", "g2");
  });
});
