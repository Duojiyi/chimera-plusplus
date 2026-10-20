import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManagerPage } from "@/components/sessions/SessionManagerPage";
import {
  sessionsApi,
  type SessionListEntry,
  type SessionTranscriptEntry,
} from "@/lib/api/sessions";
import type { SessionMessage } from "@/types";
import { setSessionFixtures } from "../msw/state";

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
const toastInfoMock = vi.fn();
const toastWarningMock = vi.fn();
const GROUP_EXPANSION_STORAGE_KEY =
  "cc-switch.sessionManager.groupExpansionState";

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
    info: (...args: unknown[]) => toastInfoMock(...args),
    warning: (...args: unknown[]) => toastWarningMock(...args),
  },
}));

vi.mock("@/components/sessions/SessionToc", () => ({
  SessionTocSidebar: () => null,
  SessionTocDialog: () => null,
}));

// Only the history-reclaim confirmation still uses the shared dialog; the
// delete confirmation is the page's own dialog and is exercised for real.
vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    message,
    confirmText,
    cancelText,
    onConfirm,
    onCancel,
  }: {
    isOpen: boolean;
    title: string;
    message: string;
    confirmText: string;
    cancelText: string;
    onConfirm: () => void;
    onCancel: () => void;
  }) =>
    isOpen ? (
      <div data-testid="confirm-dialog">
        <div>{title}</div>
        <div>{message}</div>
        <button onClick={onConfirm}>{confirmText}</button>
        <button onClick={onCancel}>{cancelText}</button>
      </div>
    ) : null,
}));

const renderPage = (appId = "codex") => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <SessionManagerPage appId={appId} />
      </QueryClientProvider>,
    ),
  };
};

const searchFor = (value: string) => {
  fireEvent.change(screen.getByRole("textbox", { name: "搜索会话" }), {
    target: { value },
  });
};

const openViewModeMenu = async () => {
  await userEvent.click(screen.getByRole("combobox", { name: /查看方式/i }));
};

const switchToGroupedView = async () => {
  await openViewModeMenu();
  const groupedOption = await screen.findByRole("option", { name: /分类/i });
  await userEvent.click(groupedOption);
  await waitFor(() =>
    expect(
      screen.queryByRole("option", { name: /分类/i }),
    ).not.toBeInTheDocument(),
  );
};

const switchProviderFilter = async (providerLabel: RegExp) => {
  const providerFilterTrigger = screen.getByRole("combobox", {
    name: /会话应用/i,
  });

  await userEvent.click(providerFilterTrigger);
  await userEvent.click(
    await screen.findByRole("option", { name: providerLabel }),
  );
};

const enterGroupedBatchMode = async () => {
  await switchToGroupedView();
  fireEvent.click(screen.getByRole("button", { name: /批量管理/i }));
};

const collapseAllGroups = () => {
  fireEvent.click(screen.getByRole("button", { name: /全部收起/i }));
};

const expandProviderGroup = (provider: string) => {
  fireEvent.click(
    screen.getByRole("button", {
      name: new RegExp(`展开或折叠 ${provider} 供应商分组`),
    }),
  );
};

const expandDirectoryGroup = (directory: string) => {
  fireEvent.click(
    screen.getByRole("button", {
      name: new RegExp(`展开或折叠 ${directory} 目录分组`),
    }),
  );
};

/** Confirm the open delete dialog, ticking the Codex acknowledgement first. */
const confirmDelete = async (confirmName: RegExp) => {
  const dialog = await screen.findByRole("dialog");
  const acknowledgement = within(dialog).queryByRole("checkbox", {
    name: /我已关闭/,
  });
  if (acknowledgement) fireEvent.click(acknowledgement);
  fireEvent.click(within(dialog).getByRole("button", { name: confirmName }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
};

// The trigger is replaced while the conversation loads, so query it afresh.
const exportButton = () => screen.getByRole("button", { name: "导出" });

const openExport = async () => {
  await waitFor(() => expect(exportButton()).toBeEnabled(), {
    timeout: 5000,
  });
  fireEvent.click(exportButton());
  return await screen.findByRole("dialog");
};

describe("SessionManagerPage", () => {
  beforeEach(() => {
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    toastWarningMock.mockReset();
    toastInfoMock.mockReset();
    Element.prototype.scrollIntoView = vi.fn();
    window.localStorage.removeItem("cc-switch.sessionManager.listViewMode");
    window.localStorage.removeItem(GROUP_EXPANSION_STORAGE_KEY);

    const sessions: SessionListEntry[] = [
      {
        providerId: "codex",
        sessionId: "codex-session-1",
        title: "Alpha Session",
        summary: "Alpha summary",
        projectDir: "/mock/codex",
        createdAt: 2,
        lastActiveAt: 20,
        sourcePath: "/mock/codex/session-1.jsonl",
        resumeCommand: "codex resume codex-session-1",
      },
      {
        providerId: "codex",
        sessionId: "codex-session-2",
        title: "Beta Session",
        summary: "Beta summary",
        projectDir: "/mock/codex",
        createdAt: 1,
        lastActiveAt: 10,
        sourcePath: "/mock/codex/session-2.jsonl",
        resumeCommand: "codex resume codex-session-2",
        archived: true,
      },
      {
        providerId: "claude",
        sessionId: "claude-session-1",
        title: "Claude Session",
        summary: "Claude summary",
        projectDir: "/mock/claude",
        createdAt: 3,
        lastActiveAt: 30,
        sourcePath: "/mock/claude/session-1.jsonl",
        resumeCommand: "claude --resume claude-session-1",
      },
      {
        providerId: "codex",
        sessionId: "codex-session-3",
        title: "Gamma Session",
        summary: "Gamma summary",
        projectDir: null,
        createdAt: 0,
        lastActiveAt: 5,
        sourcePath: "/mock/codex/session-3.jsonl",
        resumeCommand: "codex resume codex-session-3",
      },
    ];
    const messages: Record<string, SessionMessage[]> = {
      "codex:/mock/codex/session-1.jsonl": [
        { role: "user", content: "alpha", ts: 20 },
        { role: "tool", content: "OPENAI_API_KEY=sk-test-secret", ts: 21 },
        { role: "assistant", content: "done", ts: 22 },
      ],
      "codex:/mock/codex/session-2.jsonl": [
        { role: "user", content: "beta", ts: 10 },
      ],
      "codex:/mock/codex/session-3.jsonl": [
        { role: "user", content: "gamma", ts: 5 },
      ],
      "claude:/mock/claude/session-1.jsonl": [
        { role: "user", content: "claude", ts: 30 },
      ],
    };

    setSessionFixtures(sessions, messages);
  });

  it("keeps the named application selector visible even while searching", async () => {
    renderPage("all");
    const selector = await screen.findByRole("combobox", { name: "会话应用" });
    expect(selector).toHaveTextContent("应用");
    expect(selector.closest("header")).toHaveClass("session-page-heading");
    searchFor("Alpha");
    expect(screen.getByRole("combobox", { name: "会话应用" })).toBeVisible();
  });

  it("names each application by its product name in the filter", async () => {
    renderPage("all");
    await userEvent.click(
      await screen.findByRole("combobox", { name: "会话应用" }),
    );
    for (const name of [
      "Codex",
      "Claude Code",
      "Gemini CLI",
      "OpenCode",
      "Grok Build",
    ]) {
      expect(
        await screen.findByRole("option", { name: new RegExp(name) }),
      ).toBeInTheDocument();
    }
  });

  it("shows a read failure instead of an empty session and retries successfully", async () => {
    const getMessages = vi
      .spyOn(sessionsApi, "getMessages")
      .mockRejectedValueOnce(
        new Error(
          "Failed to read session file C:\\x.jsonl: 另一个程序正在使用此文件，进程无法访问。 (os error 32)",
        ),
      );
    const { client } = renderPage();
    try {
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("读取失败");
      expect(alert).toHaveTextContent("文件正被其他程序占用");
      expect(
        screen.queryByText("这条会话没有可以显示的对话。"),
      ).not.toBeInTheDocument();
      fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
      await waitFor(() =>
        expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
      );
      expect(getMessages).toHaveBeenCalledTimes(2);
      expect(
        client.getQueryData([
          "sessionMessages",
          "codex",
          "/mock/codex/session-1.jsonl",
        ]),
      ).toHaveLength(3);
    } finally {
      getMessages.mockRestore();
    }
  });

  it("says when a large session was shortened instead of failing to open it", async () => {
    const shortened: SessionTranscriptEntry[] = [
      { role: "user", content: "alpha", ts: 20 },
      {
        role: "notice",
        content: "这里有一条约 18.2 MB 的消息，超过单条显示上限，未显示。",
        truncated: true,
      },
      {
        role: "notice",
        content: "会话内容过大，后续 120 条消息未显示。",
        truncated: true,
      },
    ];
    const getMessages = vi
      .spyOn(sessionsApi, "getMessages")
      .mockResolvedValue(shortened);
    renderPage();
    try {
      const banner = (await screen.findByText("内容过大，已截断显示。"))
        .parentElement!.parentElement!;
      expect(banner).toHaveAttribute("role", "status");
      expect(banner).toHaveTextContent("记录文件本身没有改动");
      expect(screen.queryByText("读取失败")).not.toBeInTheDocument();
      const notes = screen.getAllByRole("note");
      expect(notes).toHaveLength(2);
      expect(notes[1]).toHaveTextContent("后续 120 条消息未显示");
    } finally {
      getMessages.mockRestore();
    }
  });

  it("shows a list read failure with a retry instead of an empty list", async () => {
    const list = vi
      .spyOn(sessionsApi, "list")
      .mockRejectedValueOnce(new Error("数据库错误: database is locked"));
    renderPage();
    try {
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("无法读取会话列表");
      expect(screen.queryByText("还没有会话记录")).not.toBeInTheDocument();
      fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
      expect(
        await screen.findByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument();
    } finally {
      list.mockRestore();
    }
  });

  it("explains an empty history once instead of leaving two blank panels", async () => {
    setSessionFixtures([], {});
    renderPage();
    expect(await screen.findByText("还没有会话记录")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "刷新列表" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("从左侧选择一条会话，查看完整对话。"),
    ).not.toBeInTheDocument();
  });

  it("saves Markdown through the native dialog with privacy defaults and the actual destination", async () => {
    const exportFile = vi
      .spyOn(sessionsApi, "exportFile")
      .mockResolvedValueOnce("D:\\exports\\Alpha.md");
    renderPage();
    try {
      const popover = await openExport();
      expect(popover).toHaveTextContent("默认不含工具输出");
      expect(popover).toHaveTextContent("由你选择文件夹和文件名");
      expect(within(popover).queryByRole("note")).not.toBeInTheDocument();
      fireEvent.click(
        within(popover).getByRole("button", { name: "保存 Markdown…" }),
      );
      await waitFor(() => expect(exportFile).toHaveBeenCalledTimes(1));
      const exported = exportFile.mock.calls[0][0];
      expect(exported).toMatchObject({
        fileName: "session-codex-session-1.md",
        format: "markdown",
      });
      expect(exported.content).toContain("# Alpha Session");
      expect(exported.content).toContain("alpha");
      expect(exported.content).toContain("done");
      expect(exported.content).not.toContain("sk-test-secret");
      expect(exported.content).not.toContain("/mock/codex/session-1.jsonl");
      expect(await screen.findByRole("status")).toHaveTextContent(
        "D:\\exports\\Alpha.md",
      );
      expect(toastSuccessMock).toHaveBeenCalledWith(
        "会话导出成功",
        expect.objectContaining({
          description: expect.stringContaining("D:\\exports\\Alpha.md"),
        }),
      );
    } finally {
      exportFile.mockRestore();
    }
  });

  it("still saves JSON without tool output or the record's location by default", async () => {
    const exportFile = vi
      .spyOn(sessionsApi, "exportFile")
      .mockResolvedValueOnce("D:\\exports\\Alpha.json");
    renderPage();
    try {
      const popover = await openExport();
      fireEvent.click(within(popover).getByRole("button", { name: "JSON" }));
      fireEvent.click(
        within(popover).getByRole("button", { name: "保存 JSON…" }),
      );
      await waitFor(() => expect(exportFile).toHaveBeenCalledTimes(1));
      const request = exportFile.mock.calls[0][0];
      expect(request).toMatchObject({
        fileName: "session-codex-session-1.json",
        format: "json",
      });
      const exported = JSON.parse(request.content);
      expect(exported).toMatchObject({
        version: 1,
        session: { sessionId: "codex-session-1", providerId: "codex" },
      });
      expect(exported.session).not.toHaveProperty("sourcePath");
      expect(exported.messages).toEqual([
        { role: "user", content: "alpha", ts: 20 },
        { role: "assistant", content: "done", ts: 22 },
      ]);
      await waitFor(() => expect(toastSuccessMock).toHaveBeenCalled());
    } finally {
      exportFile.mockRestore();
    }
  });

  it("includes tool output only when asked, with the risk stated as visible text", async () => {
    const exportFile = vi
      .spyOn(sessionsApi, "exportFile")
      .mockResolvedValueOnce("D:\\exports\\Alpha.json");
    renderPage();
    try {
      const popover = await openExport();
      fireEvent.click(within(popover).getByRole("button", { name: "JSON" }));
      fireEvent.click(
        within(popover).getByRole("checkbox", {
          name: "包含工具输出（可能含密钥或令牌）",
        }),
      );
      expect(within(popover).getByRole("note")).toHaveTextContent(
        "工具输出可能含有密钥、令牌或本机文件内容",
      );
      fireEvent.click(
        within(popover).getByRole("button", { name: "保存 JSON…" }),
      );
      await waitFor(() => expect(exportFile).toHaveBeenCalledTimes(1));
      const exported = JSON.parse(exportFile.mock.calls[0][0].content);
      expect(exported.messages).toHaveLength(3);
      expect(exported.messages[1]).toMatchObject({ role: "tool" });
      expect(exported.session).not.toHaveProperty("sourcePath");
      await waitFor(() => expect(toastSuccessMock).toHaveBeenCalled());
    } finally {
      exportFile.mockRestore();
    }
  });

  it("disables export while the conversation reloads or cannot be read", async () => {
    const { client } = renderPage();
    await waitFor(() => expect(exportButton()).toBeEnabled());
    let resolveMessages!: (messages: SessionMessage[]) => void;
    const getMessages = vi.spyOn(sessionsApi, "getMessages");
    getMessages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMessages = resolve;
        }),
    );
    try {
      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
      await waitFor(() => expect(getMessages).toHaveBeenCalled());
      await waitFor(() => expect(exportButton()).toBeDisabled());
      await act(async () =>
        resolveMessages([{ role: "user", content: "alpha", ts: 20 }]),
      );
      await waitFor(() => expect(exportButton()).toBeEnabled());
      getMessages.mockRejectedValue(new Error("unavailable"));
      await act(async () => {
        await client.invalidateQueries({ queryKey: ["sessionMessages"] });
      });
      await waitFor(() => expect(exportButton()).toBeDisabled());
    } finally {
      getMessages.mockRestore();
    }
  });

  it("deletes the selected session and selects the next visible session", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /删除会话/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Alpha Session")).toBeInTheDocument();

    await confirmDelete(/删除会话/);

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Beta Session" }),
      ).toBeInTheDocument(),
    );

    expect(screen.queryByText("Alpha Session")).not.toBeInTheDocument();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalled();
  });

  it("asks the user to confirm Codex is closed elsewhere before deleting", async () => {
    const deleteMany = vi.spyOn(sessionsApi, "deleteMany");
    renderPage();
    try {
      await screen.findByRole("heading", { name: "Alpha Session" });
      fireEvent.click(screen.getByRole("button", { name: /删除会话/i }));
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("派生的子会话会一并删除");
      expect(dialog).toHaveTextContent("只保留最近 20 次");
      const confirm = within(dialog).getByRole("button", { name: "删除会话" });
      expect(confirm).toBeDisabled();
      fireEvent.click(
        within(dialog).getByRole("checkbox", {
          name: "我已关闭正在使用这些会话的 Codex 窗口、CLI 或 VS Code 扩展",
        }),
      );
      expect(confirm).toBeEnabled();
      fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(deleteMany).not.toHaveBeenCalled();
    } finally {
      deleteMany.mockRestore();
    }
  });

  it("does not ask about Codex windows when no Codex session is being deleted", async () => {
    renderPage("all");
    await screen.findByRole("heading", { name: "Claude Session" });
    fireEvent.click(screen.getByRole("button", { name: /删除会话/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "删除会话" }),
    ).toBeEnabled();
  });

  it("lists the sessions a batch delete removes and counts the rest beyond eight", async () => {
    const many: SessionListEntry[] = Array.from({ length: 11 }, (_, index) => ({
      providerId: "codex",
      sessionId: `0000000${index}-batch-session`,
      title: `Batch ${index}`,
      projectDir: "/work/batch-project",
      lastActiveAt: 100 - index,
      sourcePath: `/mock/codex/batch-${index}.jsonl`,
      archived: index === 0,
    }));
    setSessionFixtures(many, {});
    renderPage();
    await screen.findByRole("heading", { name: "Batch 0" });
    fireEvent.click(screen.getByRole("button", { name: /批量管理/i }));
    fireEvent.click(screen.getByRole("button", { name: /全选当前/i }));
    fireEvent.click(screen.getByRole("button", { name: /批量删除/i }));
    const dialog = await screen.findByRole("dialog", {
      name: /删除 11 个会话/,
    });
    const items = within(
      within(dialog).getByRole("list", { name: "将删除的会话" }),
    ).getAllByRole("listitem");
    expect(items).toHaveLength(8);
    expect(items[0]).toHaveTextContent("Batch 0");
    expect(items[0]).toHaveTextContent("00000000");
    expect(items[0]).toHaveTextContent("batch-project");
    expect(items[0]).toHaveTextContent("已归档");
    expect(items[1]).not.toHaveTextContent("已归档");
    expect(dialog).toHaveTextContent("另有 3 条");
  });

  it("does not offer a retry when the delete request was refused as a whole", async () => {
    const deleteManySpy = vi
      .spyOn(sessionsApi, "deleteMany")
      .mockRejectedValueOnce(
        new Error("Codex 正在运行，请先关闭 Codex 再删除会话"),
      );

    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /批量管理/i }));
    fireEvent.click(screen.getByRole("button", { name: /全选当前/i }));
    fireEvent.click(screen.getByRole("button", { name: /批量删除/i }));
    await confirmDelete(/删除 3 个会话/);

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "Codex 正在运行，请先关闭 Codex 再删除会话",
      ),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /批量删除/i }),
      ).not.toBeDisabled(),
    );
    // Nothing was deleted, so there is nothing half-done to finish.
    expect(
      screen.queryByRole("button", { name: "重试未完成的删除" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/内容已删除/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Alpha Session" }),
    ).toBeInTheDocument();

    deleteManySpy.mockRestore();
  });

  it("reclaims history sessions after confirmation and refreshes the list", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /一键恢复所有历史会话/i }),
    );

    const dialog = screen.getByTestId("confirm-dialog");
    expect(within(dialog).getByText(/恢复所有历史会话/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: /开始恢复/i }));

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalled());
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("reports a skipped reclaim without claiming success", async () => {
    // live 未指向共享桶时归拢会把历史移到看不见的分组，后端因此跳过；
    // 这种情况必须报错而不是显示"已恢复 0 个"。
    vi.spyOn(sessionsApi, "reclaimCodexHistory").mockResolvedValueOnce({
      reclaimedJsonlFiles: 0,
      reclaimedStateRows: 0,
      deferredJsonlFiles: 0,
      sourceProviderIds: [],
      skippedReason: "live_not_custom",
    });

    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /一键恢复所有历史会话/i }),
    );
    fireEvent.click(
      within(screen.getByTestId("confirm-dialog")).getByRole("button", {
        name: /开始恢复/i,
      }),
    );

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it.each([0, 1])(
    "shows deferred reclaim counts without claiming full success (%s restored)",
    async (restored) => {
      const reclaim = vi
        .spyOn(sessionsApi, "reclaimCodexHistory")
        .mockResolvedValueOnce({
          reclaimedJsonlFiles: restored,
          reclaimedStateRows: restored * 2,
          deferredJsonlFiles: 2,
          sourceProviderIds: ["old-provider"],
          skippedReason:
            restored === 0 ? "deferred_active_session_files" : undefined,
        });
      renderPage();
      try {
        await screen.findByRole("heading", { name: "Alpha Session" });
        fireEvent.click(
          screen.getByRole("button", { name: /一键恢复所有历史会话/i }),
        );
        fireEvent.click(
          within(screen.getByTestId("confirm-dialog")).getByRole("button", {
            name: /开始恢复/i,
          }),
        );
        await waitFor(() =>
          expect(toastWarningMock).toHaveBeenCalledWith(
            "已恢复 " +
              restored +
              " 个会话文件，仍有 2 个活跃会话文件延期处理。",
            {
              description:
                expect.stringContaining("停止这些会话的写入后，再次点击恢复"),
            },
          ),
        );
        expect(toastSuccessMock).not.toHaveBeenCalled();
        expect(toastInfoMock).not.toHaveBeenCalled();
        expect(
          screen.getByRole("button", { name: /一键恢复所有历史会话/i }),
        ).toBeEnabled();
      } finally {
        reclaim.mockRestore();
      }
    },
  );

  it("removes a deleted session from filtered search results", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    searchFor("Alpha");

    await waitFor(() =>
      expect(screen.queryByText("Beta Session")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /删除会话/i }));
    await confirmDelete(/删除会话/);

    await waitFor(() =>
      expect(screen.queryByText("Alpha Session")).not.toBeInTheDocument(),
    );

    expect(screen.getByText("没有可以显示的会话。")).toBeInTheDocument();
    // Both the empty list and the search field offer to clear the search.
    expect(screen.getAllByRole("button", { name: "清除搜索" })).toHaveLength(2);
    expect(
      screen.queryByText("这条会话没有可以显示的对话。"),
    ).not.toBeInTheDocument();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalled();
  });

  it("keeps a single partial deletion retryable after its source disappears from the list", async () => {
    const session: SessionListEntry = {
      providerId: "codex",
      sessionId: "partial",
      title: "Partial Session",
      sourcePath: "/mock/codex/partial.jsonl",
    };
    setSessionFixtures([session], {});
    const deleteMany = vi
      .spyOn(sessionsApi, "deleteMany")
      .mockImplementationOnce(async (items) => {
        setSessionFixtures([], {});
        return items.map((item) => ({
          ...item,
          success: false,
          sourceDeleted: true,
          cleanupPending: true,
          error: "index locked",
        }));
      })
      .mockImplementationOnce(async (items) =>
        items.map((item) => ({
          ...item,
          success: true,
          sourceDeleted: true,
          cleanupPending: false,
        })),
      );
    const { client } = renderPage();
    try {
      await screen.findByRole("heading", { name: "Partial Session" });
      fireEvent.click(screen.getByRole("button", { name: /删除会话/i }));
      await confirmDelete(/删除会话/);
      const retry = await screen.findByRole("button", {
        name: "重试未完成的删除",
      });
      await waitFor(() => expect(retry).toBeEnabled());
      expect(screen.getByRole("alert")).toHaveTextContent(
        "1 个会话的内容已删除，但索引清理未完成",
      );
      expect(toastSuccessMock).not.toHaveBeenCalled();
      expect(toastWarningMock).toHaveBeenCalledWith(
        expect.stringContaining("索引清理未完成"),
      );
      expect(client.getQueryData(["sessions"])).toEqual([]);
      expect(
        client.getQueryData([
          "sessionMessages",
          session.providerId,
          session.sourcePath,
        ]),
      ).toBeUndefined();
      fireEvent.click(retry);
      // Only cleanup is left, and the dialog says so.
      expect(
        await screen.findByRole("dialog", { name: /完成删除/ }),
      ).toHaveTextContent("内容已经删除");
      await confirmDelete(/完成清理/);
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "重试未完成的删除" }),
        ).not.toBeInTheDocument(),
      );
      expect(deleteMany).toHaveBeenCalledTimes(2);
      expect(deleteMany.mock.calls[1][0]).toEqual(deleteMany.mock.calls[0][0]);
      expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    } finally {
      deleteMany.mockRestore();
    }
  });

  it("counts only complete deletions as success and retries only partial/failed items", async () => {
    const sessions: SessionListEntry[] = ["complete", "partial", "failed"].map(
      (id) => ({
        providerId: "codex",
        sessionId: id,
        title: id,
        sourcePath: "/mock/codex/" + id + ".jsonl",
      }),
    );
    setSessionFixtures(sessions, {});
    const deleteMany = vi
      .spyOn(sessionsApi, "deleteMany")
      .mockImplementationOnce(async (items) => {
        setSessionFixtures([sessions[2]], {});
        return items.map((item) => ({
          ...item,
          success: item.sessionId === "complete",
          sourceDeleted: item.sessionId !== "failed",
          cleanupPending: item.sessionId === "partial",
          error:
            item.sessionId === "complete" ? undefined : "delete incomplete",
        }));
      })
      .mockImplementationOnce(async (items) => {
        setSessionFixtures([], {});
        return items.map((item) => ({
          ...item,
          success: true,
          sourceDeleted: true,
          cleanupPending: false,
        }));
      });
    renderPage();
    try {
      await screen.findByRole("heading", { name: "complete" });
      fireEvent.click(screen.getByRole("button", { name: /批量管理/i }));
      fireEvent.click(screen.getByRole("button", { name: /全选当前/i }));
      fireEvent.click(screen.getByRole("button", { name: /批量删除/i }));
      await confirmDelete(/删除 3 个会话/);
      const retry = await screen.findByRole("button", {
        name: "重试未完成的删除",
      });
      await waitFor(() => expect(retry).toBeEnabled());
      expect(screen.getByRole("alert")).toHaveTextContent(
        "1 个会话待完成索引清理，1 个会话删除失败。",
      );
      expect(toastSuccessMock).toHaveBeenCalledWith("已删除 1 个会话");
      expect(toastWarningMock).toHaveBeenCalledTimes(1);
      expect(toastErrorMock).toHaveBeenCalledWith(
        "1 个会话删除失败",
        expect.anything(),
      );
      fireEvent.click(retry);
      await confirmDelete(/删除 2 个会话/);
      await waitFor(() => expect(deleteMany).toHaveBeenCalledTimes(2));
      expect(
        deleteMany.mock.calls[1][0].map((item) => item.sessionId).sort(),
      ).toEqual(["failed", "partial"]);
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "重试未完成的删除" }),
        ).not.toBeInTheDocument(),
      );
    } finally {
      deleteMany.mockRestore();
    }
  });

  it("keeps the exit batch mode button visible when search hides all sessions", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /批量管理/i }));
    searchFor("NoSuchSession");

    await waitFor(() => expect(screen.queryByText("Alpha Session")).toBeNull());

    expect(screen.getByRole("button", { name: /退出批量管理/i })).toBeVisible();
    expect(screen.getByText(/与「NoSuchSession」匹配的会话/)).toBeVisible();
  });

  it("drops hidden selections when search narrows the result set", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /批量管理/i }));
    fireEvent.click(screen.getByRole("button", { name: /全选当前/i }));

    expect(screen.getByText("已选 3 项")).toBeInTheDocument();

    searchFor("Alpha");

    await waitFor(() =>
      expect(screen.queryByText("Beta Session")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));

    await waitFor(() =>
      expect(screen.getByText("已选 1 项")).toBeInTheDocument(),
    );
  });

  it("removes successfully deleted sessions from the UI before refetch completes", async () => {
    const view = renderPage();
    let resolveInvalidate!: () => void;
    const invalidateSpy = vi
      .spyOn(view.client, "invalidateQueries")
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveInvalidate = () => resolve(undefined);
          }),
      );

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /批量管理/i }));
    fireEvent.click(screen.getByRole("button", { name: /全选当前/i }));
    fireEvent.click(screen.getByRole("button", { name: /批量删除/i }));
    await confirmDelete(/删除 3 个会话/);

    await waitFor(() => {
      expect(screen.queryByText("Alpha Session")).not.toBeInTheDocument();
      expect(screen.queryByText("Beta Session")).not.toBeInTheDocument();
    });

    await act(async () => {
      resolveInvalidate();
    });
    invalidateSpy.mockRestore();
  });

  it("tags archived sessions in the list and in the detail header", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "Alpha Session" });
    const betaRow = screen.getByRole("button", { name: /Beta Session/ });
    expect(betaRow).toHaveTextContent("已归档");
    expect(
      screen.getByRole("button", { name: /Alpha Session/ }),
    ).not.toHaveTextContent("已归档");
    fireEvent.click(betaRow);
    const heading = await screen.findByRole("heading", {
      name: "Beta Session",
    });
    expect(heading.parentElement).toHaveTextContent("已归档");
  });

  it("renders only the visible part of a long flat list", async () => {
    const many: SessionListEntry[] = Array.from(
      { length: 300 },
      (_, index) => ({
        providerId: "codex",
        sessionId: `long-${index}`,
        title: `Long list ${index}`,
        lastActiveAt: 1000 - index,
        sourcePath: `/mock/codex/long-${index}.jsonl`,
      }),
    );
    setSessionFixtures(many, {});
    renderPage();
    await screen.findByRole("heading", { name: "Long list 0" });
    const rows = screen.getAllByRole("button", { name: /Long list \d+/ });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(60);
    expect(screen.getByText("300")).toBeInTheDocument();
  });

  it("switches to grouped view collapsed by default and shows collapse control", async () => {
    renderPage("all");

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Claude Session" }),
      ).toBeInTheDocument(),
    );

    await switchToGroupedView();

    expect(
      screen.getByRole("button", { name: /全部收起/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /展开或折叠 Codex 供应商分组/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /展开或折叠 Claude Code 供应商分组/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /展开或折叠 codex 目录分组/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Alpha Session/ }),
    ).not.toBeInTheDocument();
  });

  it("drops the application level from the folder tree when one application is chosen", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    await switchToGroupedView();
    expect(
      screen.queryByRole("button", { name: /供应商分组/ }),
    ).not.toBeInTheDocument();
    expandDirectoryGroup("codex");

    expect(
      screen.getByRole("button", { name: /Alpha Session/ }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem(GROUP_EXPANSION_STORAGE_KEY)!),
      ).toEqual({
        expandedProviderIds: [],
        expandedDirectoryKeys: ["codex:/mock/codex"],
      }),
    );

    collapseAllGroups();

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Alpha Session/ }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem(GROUP_EXPANSION_STORAGE_KEY)!),
      ).toEqual({
        expandedProviderIds: [],
        expandedDirectoryKeys: [],
      }),
    );
  });

  it("keeps filtered grouped sessions collapsed until expanding the group", async () => {
    renderPage("all");

    await waitFor(() =>
      expect(screen.getByText("Alpha Session")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Alpha Session/ }));
    await switchToGroupedView();
    await switchProviderFilter(/Claude Code/i);

    await waitFor(() =>
      expect(screen.queryByText("Alpha Session")).not.toBeInTheDocument(),
    );

    expect(
      screen.getByRole("heading", { name: "Claude Session" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /供应商分组/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Claude Session/ }),
    ).not.toBeInTheDocument();

    expandDirectoryGroup("claude");

    expect(
      screen.getByRole("button", { name: /Claude Session/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Gamma Session")).not.toBeInTheDocument();
  });

  it("supports batch deletion from grouped view", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    await switchToGroupedView();
    fireEvent.click(screen.getByRole("button", { name: /批量管理/i }));
    fireEvent.click(screen.getByRole("button", { name: /全选当前/i }));
    fireEvent.click(screen.getByRole("button", { name: /批量删除/i }));
    await confirmDelete(/删除 3 个会话/);

    await waitFor(() => {
      expect(screen.queryByText("Alpha Session")).not.toBeInTheDocument();
      expect(screen.queryByText("Beta Session")).not.toBeInTheDocument();
      expect(screen.queryByText("Gamma Session")).not.toBeInTheDocument();
    });

    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalled();
  });

  it("selects visible deletable sessions by provider group in grouped batch mode", async () => {
    renderPage("all");

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Claude Session" }),
      ).toBeInTheDocument(),
    );

    await enterGroupedBatchMode();

    const codexProviderCheckbox = screen.getByRole("checkbox", {
      name: /选择 Codex 供应商分组内会话/,
    });
    const claudeProviderCheckbox = screen.getByRole("checkbox", {
      name: /选择 Claude Code 供应商分组内会话/,
    });

    fireEvent.click(codexProviderCheckbox);

    expect(codexProviderCheckbox).toBeChecked();
    expect(claudeProviderCheckbox).not.toBeChecked();
    expect(screen.getByText("已选 3 项")).toBeInTheDocument();

    fireEvent.click(codexProviderCheckbox);

    expect(codexProviderCheckbox).not.toBeChecked();
    expect(screen.getByText("已选 0 项")).toBeInTheDocument();
  });

  it("selects visible deletable sessions by directory group and marks the provider as mixed", async () => {
    renderPage("all");

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Claude Session" }),
      ).toBeInTheDocument(),
    );

    await enterGroupedBatchMode();
    expandProviderGroup("Codex");

    const providerCheckbox = screen.getByRole("checkbox", {
      name: /选择 Codex 供应商分组内会话/,
    });
    const codexDirectoryCheckbox = screen.getByRole("checkbox", {
      name: /选择 codex 目录分组内会话/,
    });

    fireEvent.click(codexDirectoryCheckbox);

    expect(codexDirectoryCheckbox).toBeChecked();
    expect(providerCheckbox).toHaveAttribute("aria-checked", "mixed");
    expect(screen.getByText("已选 2 项")).toBeInTheDocument();
  });

  it("marks grouped batch checkboxes as mixed when only one session is selected", async () => {
    renderPage("all");

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Claude Session" }),
      ).toBeInTheDocument(),
    );

    await enterGroupedBatchMode();
    expandProviderGroup("Codex");
    expandDirectoryGroup("codex");

    fireEvent.click(screen.getAllByRole("checkbox", { name: "选择会话" })[0]);

    expect(
      screen.getByRole("checkbox", {
        name: /选择 Codex 供应商分组内会话/,
      }),
    ).toHaveAttribute("aria-checked", "mixed");
    expect(
      screen.getByRole("checkbox", { name: /选择 codex 目录分组内会话/ }),
    ).toHaveAttribute("aria-checked", "mixed");
    expect(screen.getByText("已选 1 项")).toBeInTheDocument();
  });

  it("batch deletes only sessions selected from a grouped directory", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    await enterGroupedBatchMode();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /选择 codex 目录分组内会话/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /批量删除/i }));
    await confirmDelete(/删除 2 个会话/);

    await waitFor(() => {
      expect(screen.queryByText("Alpha Session")).not.toBeInTheDocument();
      expect(screen.queryByText("Beta Session")).not.toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", { name: /展开或折叠 未知目录 目录分组/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: "选择会话" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /展开或折叠 未知目录 目录分组/ }),
    );
    expect(
      screen.getByRole("checkbox", { name: "选择会话" }),
    ).toBeInTheDocument();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalled();
  });
});
