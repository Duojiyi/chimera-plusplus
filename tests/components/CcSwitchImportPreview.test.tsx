import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ccSwitchImportApi,
  type CcSwitchImportInventory,
} from "@/lib/api/ccSwitchImport";
import { CcSwitchImportPreview } from "@/components/settings/CcSwitchImportPreview";
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/api/ccSwitchImport", () => ({
  ccSwitchImportApi: { preview: vi.fn(), commit: vi.fn() },
}));
const inventory: CcSwitchImportInventory = {
  writesLive: false,
  canCommit: false,
  rows: ["new", "identical", "conflict", "unsupported"].map(
    (status, index) => ({
      app: "codex",
      sourceId: String(index),
      name: `Line ${index}`,
      status: status as CcSwitchImportInventory["rows"][number]["status"],
      reason: "核对结果",
      existingIds: status === "conflict" ? ["existing-line"] : [],
    }),
  ),
};
beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState({}, "", "/");
});
describe("cc-switch file preview", () => {
  it("cannot open native files from the browser", () => {
    render(<CcSwitchImportPreview native={false} />);
    expect(
      screen.getByRole("button", { name: "选择文件并预览" }),
    ).toBeDisabled();
    expect(open).not.toHaveBeenCalled();
  });
  it("shows all four categories while keeping commit disabled until backend approval", async () => {
    vi.mocked(open).mockResolvedValue("C:/config.json");
    vi.mocked(ccSwitchImportApi.preview).mockResolvedValue(inventory);
    render(<CcSwitchImportPreview native />);
    fireEvent.click(screen.getByRole("button", { name: "选择文件并预览" }));
    expect(await screen.findByRole("status")).toHaveTextContent("共 4 条");
    for (const label of ["新增", "与现有相同", "冲突", "不支持"]) {
      expect(
        within(screen.getByRole("region", { name: label })).getByRole(
          "heading",
        ),
      ).toHaveTextContent("1");
    }
    expect(screen.getByText(/existing-line/)).toBeVisible();
    expect(ccSwitchImportApi.preview).toHaveBeenCalledWith("C:/config.json");
    expect(
      screen.getByRole("button", { name: "确认导入（需桌面服务）" }),
    ).toBeDisabled();
  });
  it("treats dialog cancellation as no operation", async () => {
    vi.mocked(open).mockResolvedValue(null);
    render(<CcSwitchImportPreview native />);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "选择文件并预览" })),
    );
    expect(ccSwitchImportApi.preview).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "选择文件并预览" }),
    ).toBeEnabled();
  });
  it("does not expose sensitive backend errors", async () => {
    vi.mocked(open).mockResolvedValue("C:/config.json");
    vi.mocked(ccSwitchImportApi.preview).mockRejectedValue(
      new Error("secret-key"),
    );
    render(<CcSwitchImportPreview native />);
    fireEvent.click(screen.getByRole("button", { name: "选择文件并预览" }));
    expect(await screen.findByRole("alert")).not.toHaveTextContent(
      "secret-key",
    );
    expect(
      screen.getByRole("button", { name: "选择文件并预览" }),
    ).toBeEnabled();
  });
  it("ignores a stale response after native access is removed", async () => {
    let finish!: (value: CcSwitchImportInventory) => void;
    vi.mocked(open).mockResolvedValue("C:/config.json");
    vi.mocked(ccSwitchImportApi.preview).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = render(<CcSwitchImportPreview native />);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "选择文件并预览" })),
    );
    view.rerender(<CcSwitchImportPreview native={false} />);
    await act(async () => finish(inventory));
    expect(screen.queryByText("Line 0")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "选择文件并预览" }),
    ).toBeDisabled();
  });
  it("does not open another picker while one is pending", async () => {
    let finish!: (value: null) => void;
    vi.mocked(open).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<CcSwitchImportPreview native />);
    fireEvent.click(screen.getByRole("button", { name: "选择文件并预览" }));
    fireEvent.click(screen.getByRole("button", { name: "正在读取…" }));
    expect(open).toHaveBeenCalledTimes(1);
    await act(async () => finish(null));
  });
});

it("defaults to new rows only and updates choices without committing", async () => {
  vi.mocked(open).mockResolvedValue("C:/config.json");
  vi.mocked(ccSwitchImportApi.preview).mockResolvedValue(inventory);
  render(<CcSwitchImportPreview native />);
  fireEvent.click(screen.getByRole("button", { name: "选择文件并预览" }));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByRole("checkbox", { name: "Line 0" }),
  ).toBeChecked();
  await waitFor(() =>
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus(),
  );
  expect(within(dialog).getByRole("radio", { name: "保留现有" })).toBeChecked();
  expect(within(dialog).getByRole("status")).toHaveTextContent("已选择 1 条");
  fireEvent.click(within(dialog).getByRole("radio", { name: "覆盖" }));
  expect(within(dialog).getByRole("status")).toHaveTextContent("已选择 2 条");
  fireEvent.click(within(dialog).getByRole("checkbox"));
  expect(within(dialog).getByRole("status")).toHaveTextContent("已选择 1 条");
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "选择文件并预览" })).toHaveFocus();
});
it("does not offer an ambiguous replacement", async () => {
  vi.mocked(open).mockResolvedValue("C:/config.json");
  vi.mocked(ccSwitchImportApi.preview).mockResolvedValue({
    ...inventory,
    rows: [{ ...inventory.rows[2], existingIds: ["one", "two"] }],
  });
  render(<CcSwitchImportPreview native />);
  fireEvent.click(screen.getByRole("button", { name: "选择文件并预览" }));
  await screen.findByRole("dialog");
  expect(screen.getByRole("radio", { name: "覆盖" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("已选择 0 条");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("shows labelled design examples without opening files or invoking native preview", async () => {
  window.history.replaceState({}, "", "/?preview=design");
  render(<CcSwitchImportPreview native={false} />);
  fireEvent.click(screen.getByRole("button", { name: "查看导入设计示例" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(/非本机数据/)).toBeVisible();
  expect(within(dialog).getByRole("status")).toHaveTextContent(
    "共 12 条，已选择 3 条",
  );
  const identical = within(dialog).getByRole("region", { name: "与现有相同" });
  expect(
    within(identical).getByText("DeepSeek、智谱 GLM、阿里云百炼、OpenRouter"),
  ).toBeVisible();
  expect(within(identical).queryByRole("checkbox")).not.toBeInTheDocument();
  expect(within(identical).getAllByText("自动跳过，不重复导入")).toHaveLength(
    1,
  );
  expect(open).not.toHaveBeenCalled();
  expect(ccSwitchImportApi.preview).not.toHaveBeenCalled();
});

describe("cc-switch selected import", () => {
  const ready = { ...inventory, canCommit: true, previewId: "preview-once" };
  async function show(onImported = vi.fn()) {
    vi.mocked(open).mockResolvedValue("C:/config.json");
    vi.mocked(ccSwitchImportApi.preview).mockResolvedValue(ready);
    const view = render(
      <CcSwitchImportPreview native onImported={onImported} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "选择文件并预览" }));
    await screen.findByRole("dialog");
    return view;
  }
  it("submits only selected new rows and the preview token", async () => {
    const refresh = vi.fn();
    vi.mocked(ccSwitchImportApi.commit).mockResolvedValue({
      imported: 1,
      backupId: "backup.db",
      writesLive: false,
    });
    await show(refresh);
    fireEvent.click(screen.getByRole("button", { name: "确认导入 1 条" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "已导入 1 条线路；备份：backup.db",
      ),
    );
    expect(ccSwitchImportApi.commit).toHaveBeenCalledExactlyOnceWith(
      "preview-once",
      [{ app: "codex", sourceId: "0" }],
    );
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("requires explicit overwrite and passes the unique destination ID", async () => {
    vi.mocked(ccSwitchImportApi.commit).mockResolvedValue({
      imported: 1,
      backupId: "backup.db",
      writesLive: false,
    });
    await show();
    fireEvent.click(screen.getByRole("checkbox", { name: "Line 0" }));
    expect(
      screen.getByRole("button", { name: "确认导入 0 条" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "覆盖" }));
    fireEvent.click(screen.getByRole("button", { name: "确认导入 1 条" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(ccSwitchImportApi.commit).toHaveBeenCalledExactlyOnceWith(
      "preview-once",
      [{ app: "codex", sourceId: "2", replaceId: "existing-line" }],
    );
  });
  it("blocks duplicate submission, cancellation and changes while committing", async () => {
    let finish!: (value: {
      imported: number;
      backupId: string;
      writesLive: boolean;
    }) => void;
    vi.mocked(ccSwitchImportApi.commit).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await show();
    const confirm = screen.getByRole("button", { name: "确认导入 1 条" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Line 0" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "覆盖" })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(ccSwitchImportApi.commit).toHaveBeenCalledOnce();
    await act(async () =>
      finish({ imported: 1, backupId: "backup.db", writesLive: false }),
    );
  });
  it.each([
    "IMPORT_PREVIEW_EXPIRED",
    "IMPORT_SOURCE_CHANGED",
    "IMPORT_DATABASE_CHANGED",
    "secret-key:/private/config.json",
  ])(
    "consumes failed preview and refreshes without exposing raw errors: %s",
    async (failure) => {
      const refresh = vi.fn();
      vi.mocked(ccSwitchImportApi.commit).mockRejectedValue(failure);
      await show(refresh);
      fireEvent.click(screen.getByRole("button", { name: "确认导入 1 条" }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(/重新/);
      expect(alert).not.toHaveTextContent(failure);
      expect(refresh).toHaveBeenCalledOnce();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "选择文件并预览" }),
      ).toBeEnabled();
    },
  );
  it.each([{ previewId: null }, { writesLive: true }, { canCommit: false }])(
    "never commits a preview without all safety gates: %j",
    async (patch) => {
      vi.mocked(open).mockResolvedValue("C:/config.json");
      vi.mocked(ccSwitchImportApi.preview).mockResolvedValue({
        ...ready,
        ...patch,
      });
      render(<CcSwitchImportPreview native />);
      fireEvent.click(screen.getByRole("button", { name: "选择文件并预览" }));
      await screen.findByRole("dialog");
      fireEvent.click(
        screen.getByRole("button", { name: "确认导入（需桌面服务）" }),
      );
      expect(ccSwitchImportApi.commit).not.toHaveBeenCalled();
    },
  );
  it("ignores a late commit result after native access is removed", async () => {
    const refresh = vi.fn();
    let finish!: (value: {
      imported: number;
      backupId: string;
      writesLive: boolean;
    }) => void;
    vi.mocked(ccSwitchImportApi.commit).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = await show(refresh);
    fireEvent.click(screen.getByRole("button", { name: "确认导入 1 条" }));
    view.rerender(
      <CcSwitchImportPreview native={false} onImported={refresh} />,
    );
    await act(async () =>
      finish({ imported: 1, backupId: "backup.db", writesLive: false }),
    );
    expect(screen.queryByText(/已导入/)).not.toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "选择文件并预览" }),
    ).toBeDisabled();
  });
});
