import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LiveBackupsPanel } from "@/components/LiveBackupsPanel";
import { liveBackupsApi, type LiveBackup } from "@/lib/api/liveBackups";
import { toast } from "sonner";
vi.mock("@/lib/api/liveBackups", () => ({
  liveBackupsApi: {
    list: vi.fn(),
    openDirectory: vi.fn(),
    create: vi.fn(),
    restore: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
const backup: LiveBackup = {
  id: "backup-1",
  app: "codex",
  createdAt: 1790900000000,
  reason: "prePrompt",
  files: ["C:\\private\\AGENTS.md"],
  identityFingerprint: "private-fingerprint",
  path: "C:/private/backup.json",
  sizeBytes: 8192,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(liveBackupsApi.list).mockResolvedValue([backup]);
  vi.mocked(liveBackupsApi.create).mockResolvedValue(backup);
  vi.mocked(liveBackupsApi.delete).mockResolvedValue();
  vi.mocked(liveBackupsApi.restore).mockResolvedValue({
    restored: backup.files,
    preRestoreBackupId: "pre-1",
    identityChanged: false,
  });
});
async function confirmRestore() {
  fireEvent.click(
    await screen.findByRole("button", { name: "恢复备份 backup-1" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "确认恢复" }));
}
describe("Live backup panel", () => {
  it("opens the managed directory without sending a path or refreshing backups", async () => {
    render(<LiveBackupsPanel />);
    await screen.findByText("AGENTS.md");
    fireEvent.click(screen.getByRole("button", { name: "打开备份目录" }));
    await waitFor(() =>
      expect(liveBackupsApi.openDirectory).toHaveBeenCalledWith("codex"),
    );
    expect(liveBackupsApi.list).toHaveBeenCalledTimes(1);
    expect(liveBackupsApi.create).not.toHaveBeenCalled();
  });
  it("blocks duplicate opens and backup mutations until the opener settles", async () => {
    let finish!: () => void;
    vi.mocked(liveBackupsApi.openDirectory).mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    render(<LiveBackupsPanel />);
    await screen.findByText("AGENTS.md");
    const button = screen.getByRole("button", { name: "打开备份目录" });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(screen.getByRole("button", { name: "创建备份" })).toBeDisabled();
    fireEvent.click(button);
    expect(liveBackupsApi.openDirectory).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(button).toBeEnabled();
  });
  it("sanitizes directory open failures and permits retry", async () => {
    vi.mocked(liveBackupsApi.openDirectory).mockRejectedValueOnce(
      new Error("secret-path"),
    );
    render(<LiveBackupsPanel />);
    await screen.findByText("AGENTS.md");
    const button = screen.getByRole("button", { name: "打开备份目录" });
    fireEvent.click(button);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "无法打开备份目录，请检查本机文件管理器。",
      ),
    );
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() =>
      expect(liveBackupsApi.openDirectory).toHaveBeenCalledTimes(2),
    );
  });
  it("renders native summaries using millisecond timestamps without private paths", async () => {
    render(<LiveBackupsPanel />);
    expect(await screen.findByText("AGENTS.md")).toBeInTheDocument();
    expect(
      screen.getByText(new Date(backup.createdAt).toLocaleString()),
    ).toBeInTheDocument();
    expect(screen.getByText("提示词写入前")).toBeInTheDocument();
    expect(screen.getByText("8 KiB")).toBeInTheDocument();
    expect(screen.getByText("backup-1")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")).toHaveLength(5);
    expect(screen.getAllByRole("cell")).toHaveLength(5);
    expect(document.body).not.toHaveTextContent("private");
    expect(liveBackupsApi.list).toHaveBeenCalledWith("codex");
  });
  it("keeps the table headings while loading and when empty", async () => {
    let finish!: (rows: LiveBackup[]) => void;
    vi.mocked(liveBackupsApi.list).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<LiveBackupsPanel />);
    expect(screen.getAllByRole("columnheader")).toHaveLength(5);
    expect(screen.getByRole("status")).toHaveTextContent("正在读取");
    await act(async () => finish([]));
    expect(screen.getAllByRole("columnheader")).toHaveLength(5);
    expect(screen.getByText("暂无 Live 备份。")).toBeInTheDocument();
  });
  it("does not invent a size for older summaries", async () => {
    vi.mocked(liveBackupsApi.list).mockResolvedValue([
      { ...backup, sizeBytes: undefined },
    ]);
    render(<LiveBackupsPanel />);
    expect(await screen.findByText("—")).toBeInTheDocument();
    expect(screen.queryByText(/KiB/)).not.toBeInTheDocument();
  });
  it("does not restore when confirmation is cancelled", async () => {
    render(<LiveBackupsPanel />);
    fireEvent.click(
      await screen.findByRole("button", { name: "恢复备份 backup-1" }),
    );
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "提示词启用状态",
    );
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(liveBackupsApi.restore).not.toHaveBeenCalled();
  });
  it("serializes restoration and reports identity differences only after success", async () => {
    let finish!: (
      result: Awaited<ReturnType<typeof liveBackupsApi.restore>>,
    ) => void;
    vi.mocked(liveBackupsApi.restore).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<LiveBackupsPanel />);
    await confirmRestore();
    const confirm = screen.getByRole("button", { name: "确认恢复" });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(liveBackupsApi.restore).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    await act(async () =>
      finish({
        restored: backup.files,
        preRestoreBackupId: "pre-1",
        identityChanged: true,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(toast.success).toHaveBeenCalledWith("已恢复 1 个文件");
    expect(toast.info).toHaveBeenCalledWith(
      expect.stringContaining("登录凭据未修改"),
    );
    expect(liveBackupsApi.list).toHaveBeenCalledTimes(2);
  });
  it("keeps failures retryable and sanitizes native errors", async () => {
    vi.mocked(liveBackupsApi.restore).mockRejectedValueOnce(
      new Error("secret-path"),
    );
    render(<LiveBackupsPanel />);
    await confirmRestore();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "确认恢复" }),
      ).not.toBeDisabled(),
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      expect.not.stringContaining("secret-path"),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认恢复" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(liveBackupsApi.restore).toHaveBeenCalledTimes(2);
  });
  it("does not announce a created backup when no live file exists", async () => {
    vi.mocked(liveBackupsApi.create).mockResolvedValue(null);
    render(<LiveBackupsPanel />);
    await screen.findByText("AGENTS.md");
    fireEvent.click(screen.getByRole("button", { name: "创建备份" }));
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        expect.stringContaining("未创建备份"),
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
  it("confirms deletion and reloads the actual list", async () => {
    render(<LiveBackupsPanel />);
    fireEvent.click(
      await screen.findByRole("button", { name: "删除备份 backup-1" }),
    );
    expect(liveBackupsApi.delete).not.toHaveBeenCalled();
    vi.mocked(liveBackupsApi.list).mockResolvedValue([]);
    fireEvent.click(await screen.findByRole("button", { name: "确认删除" }));
    expect(await screen.findByText("暂无 Live 备份。")).toBeInTheDocument();
    expect(liveBackupsApi.delete).toHaveBeenCalledWith("codex", "backup-1");
  });
  it("clears stale lists on refresh failure and permits retry", async () => {
    render(<LiveBackupsPanel />);
    await screen.findByText("AGENTS.md");
    vi.mocked(liveBackupsApi.list).mockRejectedValueOnce(new Error("secret"));
    fireEvent.click(screen.getByRole("button", { name: "刷新备份" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("读取失败");
    expect(screen.queryByText("AGENTS.md")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建备份" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "刷新备份" }));
    expect(await screen.findByText("AGENTS.md")).toBeInTheDocument();
  });
});

describe("multi-tool Live recovery", () => {
  it("uses the selected tool for listing, creating, opening and restoring", async () => {
    render(<LiveBackupsPanel />);
    await screen.findByText("AGENTS.md");
    fireEvent.change(screen.getByLabelText("Live 备份工具"), {
      target: { value: "gemini" },
    });
    await waitFor(() =>
      expect(liveBackupsApi.list).toHaveBeenCalledWith("gemini"),
    );
    fireEvent.click(await screen.findByRole("button", { name: "创建备份" }));
    await waitFor(() =>
      expect(liveBackupsApi.create).toHaveBeenCalledWith("gemini"),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "打开备份目录" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "打开备份目录" }));
    await waitFor(() =>
      expect(liveBackupsApi.openDirectory).toHaveBeenCalledWith("gemini"),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "恢复备份 backup-1" }),
      ).toBeEnabled(),
    );
    await confirmRestore();
    await waitFor(() =>
      expect(liveBackupsApi.restore).toHaveBeenCalledWith("gemini", "backup-1"),
    );
  });
  it("discards a previous tool's late list response", async () => {
    let resolve!: (rows: LiveBackup[]) => void;
    vi.mocked(liveBackupsApi.list).mockImplementation((app) =>
      app === "codex"
        ? new Promise((done) => {
            resolve = done;
          })
        : Promise.resolve([]),
    );
    render(<LiveBackupsPanel />);
    fireEvent.change(screen.getByLabelText("Live 备份工具"), {
      target: { value: "claude" },
    });
    await screen.findByText("暂无 Live 备份。");
    await act(async () => resolve([backup]));
    expect(screen.queryByText("AGENTS.md")).not.toBeInTheDocument();
  });
});

it("refreshes the owner after a successful Live restore and prevents tool changes while restoring", async () => {
  let finish!: (result: {
    restored: string[];
    preRestoreBackupId: string | null;
    identityChanged: boolean;
  }) => void;
  vi.mocked(liveBackupsApi.restore).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const onRestored = vi.fn();
  render(<LiveBackupsPanel onRestored={onRestored} />);
  await confirmRestore();
  expect(screen.getByLabelText("Live 备份工具")).toBeDisabled();
  expect(onRestored).not.toHaveBeenCalled();
  await act(async () =>
    finish({
      restored: backup.files,
      preRestoreBackupId: "safety",
      identityChanged: false,
    }),
  );
  expect(onRestored).toHaveBeenCalledOnce();
  expect(screen.getByLabelText("Live 备份工具")).toBeEnabled();
});
