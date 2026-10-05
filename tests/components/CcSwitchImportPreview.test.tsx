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
  type CcSwitchImportResult,
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
      replaceable: status === "conflict",
      sanitizedKeys: status === "new" ? ["notify"] : [],
    }),
  ),
};
const imported: CcSwitchImportResult = {
  rows: [
    { app: "codex", sourceId: "0", name: "Line 0", outcome: "imported" },
    { app: "codex", sourceId: "2", name: "Line 2", outcome: "skipped" },
  ],
  imported: 1,
  replaced: 0,
  skipped: 1,
  failed: 0,
  backupName: "db_backup_20261004_101500.db",
  sanitizedKeys: ["notify"],
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
  it("shows all four categories while import stays unavailable until the backend allows it", async () => {
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
    expect(screen.getAllByText("Codex · 核对结果")).toHaveLength(3);
    expect(ccSwitchImportApi.preview).toHaveBeenCalledWith("C:/config.json");
    expect(
      screen.getByRole("button", { name: "导入所选 1 条" }),
    ).toBeDisabled();
    expect(
      screen.getByText("当前版本未开放导入写入，只能核对。"),
    ).toBeVisible();
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
  fireEvent.click(within(dialog).getByRole("radio", { name: "作为新线路" }));
  expect(within(dialog).getByRole("status")).toHaveTextContent("已选择 2 条");
  fireEvent.click(within(dialog).getByRole("checkbox"));
  expect(within(dialog).getByRole("status")).toHaveTextContent("已选择 1 条");
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "选择文件并预览" })).toHaveFocus();
  expect(ccSwitchImportApi.commit).not.toHaveBeenCalled();
});
it.each([
  {
    existingIds: ["one", "two"],
    hint: "匹配到多条现有线路，无法确定覆盖哪一条。",
  },
  {
    existingIds: ["current-line"],
    hint: "现有线路正在使用或受保护，不能覆盖。",
  },
])(
  "does not offer an ambiguous or protected replacement: $hint",
  async ({ existingIds, hint }) => {
    vi.mocked(open).mockResolvedValue("C:/config.json");
    vi.mocked(ccSwitchImportApi.preview).mockResolvedValue({
      ...inventory,
      rows: [{ ...inventory.rows[2], existingIds, replaceable: false }],
    });
    render(<CcSwitchImportPreview native />);
    fireEvent.click(screen.getByRole("button", { name: "选择文件并预览" }));
    await screen.findByRole("dialog");
    expect(screen.getByRole("radio", { name: "覆盖" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "作为新线路" })).toBeEnabled();
    expect(screen.getByText(hint)).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("已选择 0 条");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  },
);
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
  expect(
    within(dialog).getByRole("button", { name: "导入所选 3 条" }),
  ).toBeDisabled();
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
  function proceed(count: number) {
    fireEvent.click(
      screen.getByRole("button", { name: `导入所选 ${count} 条` }),
    );
  }
  it("states exactly what will be written, then sends a decision for every reviewed row", async () => {
    const refresh = vi.fn();
    vi.mocked(ccSwitchImportApi.commit).mockResolvedValue(imported);
    await show(refresh);
    proceed(1);
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "确认导入" }),
    ).toBeVisible();
    expect(dialog).toHaveAccessibleDescription(
      "将新增 1 条线路，不会切换当前线路，不会改写任何工具的配置文件。导入前会自动备份数据库。",
    );
    const plan = within(dialog).getByRole("list", { name: "将写入的线路" });
    expect(within(plan).getByRole("listitem")).toHaveTextContent(
      "Line 0Codex · 新增",
    );
    expect(
      within(dialog).getByText("导入时会移除不安全的配置项：notify"),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "返回修改" }),
      ).toHaveFocus(),
    );
    expect(ccSwitchImportApi.commit).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认导入" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    const outcome = screen.getByRole("status");
    expect(outcome).toHaveTextContent("已导入 1 条线路");
    expect(outcome).toHaveTextContent("新增 1 条 · 跳过 1 条");
    expect(outcome).toHaveTextContent(
      "导入前备份：db_backup_20261004_101500.db",
    );
    expect(outcome).toHaveTextContent("已移除不安全的配置项：notify");
    expect(outcome).toHaveTextContent("导入的线路均未启用");
    expect(ccSwitchImportApi.commit).toHaveBeenCalledExactlyOnceWith(
      "preview-once",
      [
        { app: "codex", sourceId: "0", action: "import" },
        { app: "codex", sourceId: "2", action: "skip" },
      ],
    );
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("requires an explicit conflict choice and states replacements before sending them", async () => {
    vi.mocked(ccSwitchImportApi.commit).mockResolvedValue({
      ...imported,
      imported: 1,
      replaced: 0,
      skipped: 0,
    });
    await show();
    fireEvent.click(screen.getByRole("checkbox", { name: "Line 0" }));
    expect(
      screen.getByRole("button", { name: "导入所选 0 条" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "覆盖" }));
    proceed(1);
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
      "将覆盖 1 条现有线路，不会切换当前线路，不会改写任何工具的配置文件。导入前会自动备份数据库。",
    );
    expect(screen.getByRole("listitem")).toHaveTextContent(
      "覆盖现有线路 existing-line",
    );
    fireEvent.click(screen.getByRole("button", { name: "返回修改" }));
    expect(screen.getByRole("radio", { name: "覆盖" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "作为新线路" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Line 0" }));
    proceed(2);
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
      "将新增 2 条线路，不会切换当前线路，不会改写任何工具的配置文件。导入前会自动备份数据库。",
    );
    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(ccSwitchImportApi.commit).toHaveBeenCalledExactlyOnceWith(
      "preview-once",
      [
        { app: "codex", sourceId: "0", action: "import" },
        { app: "codex", sourceId: "2", action: "duplicate" },
      ],
    );
  });
  it("blocks duplicate submission, going back and Escape while committing", async () => {
    let finish!: (value: CcSwitchImportResult) => void;
    vi.mocked(ccSwitchImportApi.commit).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await show();
    proceed(1);
    const confirm = screen.getByRole("button", { name: "确认导入" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(
      screen.getByRole("button", { name: "正在备份并导入…" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "返回修改" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "正在导入…" })).toBeDisabled();
    expect(
      within(screen.getByRole("dialog")).getByRole("status"),
    ).toHaveTextContent("正在备份数据库并写入线路");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.getByRole("heading", { name: "确认导入" }),
    ).toBeInTheDocument();
    expect(ccSwitchImportApi.commit).toHaveBeenCalledOnce();
    await act(async () => finish(imported));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("returns to the review on Escape before anything is sent", async () => {
    await show();
    proceed(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.getByRole("heading", { name: "从 cc-switch 导入线路？" }),
    ).toBeInTheDocument();
    expect(ccSwitchImportApi.commit).not.toHaveBeenCalled();
  });
  it.each([
    ["IMPORT_PREVIEW_EXPIRED", "预览已过期或已使用，未写入任何线路"],
    ["IMPORT_SOURCE_CHANGED", "源文件在预览后有改动，未写入任何线路"],
    ["IMPORT_DATABASE_CHANGED", "本机线路在预览后有改动，未写入任何线路"],
    ["IMPORT_BACKUP_FAILED", "导入前备份失败，未写入任何线路"],
    ["secret-key:/private/config.json", "无法确认导入结果"],
  ])(
    "shows one retry-safe message for %s and re-reads the same file",
    async (failure, message) => {
      const refresh = vi.fn();
      vi.mocked(ccSwitchImportApi.commit).mockRejectedValue(failure);
      await show(refresh);
      proceed(1);
      fireEvent.click(screen.getByRole("button", { name: "确认导入" }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(message);
      expect(alert).not.toHaveTextContent(failure);
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(refresh).toHaveBeenCalledOnce();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "重新读取文件" }));
      await screen.findByRole("dialog");
      expect(open).toHaveBeenCalledOnce();
      expect(ccSwitchImportApi.preview).toHaveBeenCalledTimes(2);
      expect(ccSwitchImportApi.preview).toHaveBeenLastCalledWith(
        "C:/config.json",
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );
  it("lists rows the backend refused to write", async () => {
    vi.mocked(ccSwitchImportApi.commit).mockResolvedValue({
      ...imported,
      rows: [
        imported.rows[0],
        {
          app: "codex",
          sourceId: "2",
          name: "Line 2",
          outcome: "failed",
          reason: "该线路正在使用，未覆盖",
        },
      ],
      skipped: 0,
      failed: 1,
      sanitizedKeys: [],
    });
    await show();
    fireEvent.click(screen.getByRole("radio", { name: "覆盖" }));
    proceed(2);
    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    const outcome = screen.getByRole("status");
    expect(outcome).toHaveTextContent("新增 1 条 · 失败 1 条");
    expect(within(outcome).getByRole("listitem")).toHaveTextContent(
      "Line 2：该线路正在使用，未覆盖",
    );
    expect(outcome).not.toHaveTextContent("已移除不安全的配置项");
  });
  it.each([{ previewId: null }, { writesLive: true }, { canCommit: false }])(
    "never proceeds without all safety gates: %j",
    async (patch) => {
      vi.mocked(open).mockResolvedValue("C:/config.json");
      vi.mocked(ccSwitchImportApi.preview).mockResolvedValue({
        ...ready,
        ...patch,
      });
      render(<CcSwitchImportPreview native />);
      fireEvent.click(screen.getByRole("button", { name: "选择文件并预览" }));
      await screen.findByRole("dialog");
      const proceedButton = screen.getByRole("button", {
        name: "导入所选 1 条",
      });
      expect(proceedButton).toBeDisabled();
      fireEvent.click(proceedButton);
      expect(screen.queryByRole("heading", { name: "确认导入" })).toBeNull();
      expect(ccSwitchImportApi.commit).not.toHaveBeenCalled();
    },
  );
  it("ignores a late commit result after native access is removed", async () => {
    const refresh = vi.fn();
    let finish!: (value: CcSwitchImportResult) => void;
    vi.mocked(ccSwitchImportApi.commit).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = await show(refresh);
    proceed(1);
    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));
    view.rerender(
      <CcSwitchImportPreview native={false} onImported={refresh} />,
    );
    await act(async () => finish(imported));
    expect(screen.queryByText(/已导入/)).not.toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "选择文件并预览" }),
    ).toBeDisabled();
  });
});
