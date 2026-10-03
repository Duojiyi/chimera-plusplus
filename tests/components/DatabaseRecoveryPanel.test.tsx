import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseRecoveryPanel } from "@/components/settings/DatabaseRecoveryPanel";
import { backupsApi } from "@/lib/api/settings";
import { promptCodexImportReview } from "@/utils/codexImportReview";
import { toast } from "sonner";
vi.mock("@/lib/api/settings", () => ({
  backupsApi: {
    listDbBackups: vi.fn(),
    createDbBackup: vi.fn(),
    restoreDbBackup: vi.fn(),
    deleteDbBackup: vi.fn(),
  },
}));
vi.mock("@/utils/codexImportReview", () => ({
  promptCodexImportReview: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
function mount(onRestored = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <DatabaseRecoveryPanel onRestored={onRestored} />
    </QueryClientProvider>,
  );
  return onRestored;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(backupsApi.listDbBackups).mockResolvedValue([
    { filename: "saved.db", createdAt: "2026-10-03", sizeBytes: 2048 },
  ]);
  vi.mocked(backupsApi.restoreDbBackup).mockResolvedValue("safety.db");
});
describe("database recovery", () => {
  it("only reads on mount and requires confirmation before restoring and refreshing", async () => {
    const restored = mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "恢复 saved.db" }),
    );
    expect(backupsApi.restoreDbBackup).not.toHaveBeenCalled();
    expect(backupsApi.createDbBackup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认恢复数据库" }));
    await waitFor(() => expect(restored).toHaveBeenCalledOnce());
    expect(backupsApi.restoreDbBackup).toHaveBeenCalledExactlyOnceWith(
      "saved.db",
    );
    expect(promptCodexImportReview).toHaveBeenCalledOnce();
  });
  it("reports partial restore, refreshes, closes confirmation and never claims full success", async () => {
    vi.mocked(backupsApi.restoreDbBackup).mockRejectedValue({
      dbRestored: true,
      backupId: "safe.db",
      warning: "failed",
    });
    const restored = mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "恢复 saved.db" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认恢复数据库" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("不要重复恢复");
    await waitFor(() => expect(restored).toHaveBeenCalledOnce());
    expect(toast.success).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "确认恢复数据库" }),
    ).not.toBeInTheDocument();
  });
  it("does not present a failed list as empty and allows retry", async () => {
    vi.mocked(backupsApi.listDbBackups).mockRejectedValueOnce(
      new Error("private path"),
    );
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("读取失败");
    expect(screen.queryByText("暂无数据库备份。")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "刷新数据库备份" }));
    await screen.findByRole("button", { name: "恢复 saved.db" });
  });
  it("deletes only after confirmation without restoring", async () => {
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "删除 saved.db" }),
    );
    expect(backupsApi.deleteDbBackup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认删除数据库备份" }));
    await waitFor(() =>
      expect(backupsApi.deleteDbBackup).toHaveBeenCalledWith("saved.db"),
    );
    expect(backupsApi.restoreDbBackup).not.toHaveBeenCalled();
  });
});

it("locks duplicate database restores until completion", async () => {
  let finish!: (id: string) => void;
  vi.mocked(backupsApi.restoreDbBackup).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "恢复 saved.db" }));
  const confirm = screen.getByRole("button", { name: "确认恢复数据库" });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(backupsApi.restoreDbBackup).toHaveBeenCalledTimes(1);
  expect(confirm).toBeDisabled();
  await act(async () => finish("safety.db"));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "创建数据库备份" }),
    ).toBeEnabled(),
  );
});
