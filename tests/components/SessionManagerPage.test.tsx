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
import { sessionsApi } from "@/lib/api/sessions";
import type { SessionMessage, SessionMeta } from "@/types";
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

const openSearch = () => {
  const searchButton = Array.from(screen.getAllByRole("button")).find(
    (button) => button.querySelector(".lucide-search"),
  );

  if (!searchButton) {
    throw new Error("Search button not found");
  }

  fireEvent.click(searchButton);
};

const closeSearch = () => {
  const closeButton = Array.from(screen.getAllByRole("button")).find((button) =>
    button.querySelector(".lucide-x"),
  );

  if (!closeButton) {
    throw new Error("Search close button not found");
  }

  fireEvent.click(closeButton);
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
    name: /供应商筛选/i,
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

const expandDirectoryGroup = (provider: string, directory: string) => {
  fireEvent.click(
    screen.getByRole("button", {
      name: new RegExp(`展开或折叠 ${provider} 供应商分组`),
    }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: new RegExp(`展开或折叠 ${directory} 目录分组`),
    }),
  );
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

    const sessions: SessionMeta[] = [
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

  it("shows a message query error instead of an empty session and retries successfully", async () => {
    const getMessages = vi
      .spyOn(sessionsApi, "getMessages")
      .mockRejectedValueOnce(new Error("invalid compressed session"));
    const { client } = renderPage();
    try {
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("无法读取会话消息");
      expect(
        screen.queryByText("sessionManager.emptySession"),
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
      ).toEqual([{ role: "user", content: "alpha", ts: 20 }]);
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

    const dialog = screen.getByTestId("confirm-dialog");
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText(/Alpha Session/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: /删除会话/i }));

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Beta Session" }),
      ).toBeInTheDocument(),
    );

    expect(screen.queryByText("Alpha Session")).not.toBeInTheDocument();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalled();
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

    openSearch();

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Alpha" },
    });

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /删除会话/i }));

    const dialog = screen.getByTestId("confirm-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /删除会话/i }));

    await waitFor(() =>
      expect(screen.queryByText("Alpha Session")).not.toBeInTheDocument(),
    );

    expect(
      screen.getByText("sessionManager.selectSession"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("sessionManager.emptySession"),
    ).not.toBeInTheDocument();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalled();
  });

  it("keeps a single partial deletion retryable after its source disappears from the list", async () => {
    const session: SessionMeta = {
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
      fireEvent.click(
        within(screen.getByTestId("confirm-dialog")).getByRole("button", {
          name: /删除会话/i,
        }),
      );
      const retry = await screen.findByRole("button", {
        name: "重试未完成的删除",
      });
      await waitFor(() => expect(retry).toBeEnabled());
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
      expect(
        screen.queryByText("sessionManager.emptySession"),
      ).not.toBeInTheDocument();
      fireEvent.click(retry);
      fireEvent.click(
        within(screen.getByTestId("confirm-dialog")).getByRole("button", {
          name: /删除会话/i,
        }),
      );
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
    const sessions: SessionMeta[] = ["complete", "partial", "failed"].map(
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
      fireEvent.click(
        within(screen.getByTestId("confirm-dialog")).getByRole("button", {
          name: /删除所选会话/i,
        }),
      );
      const retry = await screen.findByRole("button", {
        name: "重试未完成的删除",
      });
      await waitFor(() => expect(retry).toBeEnabled());
      expect(toastSuccessMock).toHaveBeenCalledWith("已删除 1 个会话");
      expect(toastWarningMock).toHaveBeenCalledTimes(1);
      expect(toastErrorMock).toHaveBeenCalledWith(
        "1 个会话删除失败",
        expect.anything(),
      );
      fireEvent.click(retry);
      fireEvent.click(
        within(screen.getByTestId("confirm-dialog")).getByRole("button", {
          name: /删除所选会话/i,
        }),
      );
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

  it("restores batch delete controls when deleteMany rejects", async () => {
    const deleteManySpy = vi
      .spyOn(sessionsApi, "deleteMany")
      .mockRejectedValueOnce(new Error("network error"));

    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /批量管理/i }));
    fireEvent.click(screen.getByRole("button", { name: /全选当前/i }));
    fireEvent.click(screen.getByRole("button", { name: /批量删除/i }));

    const dialog = screen.getByTestId("confirm-dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: /删除所选会话/i }),
    );

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("network error"),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /批量删除/i }),
      ).not.toBeDisabled(),
    );

    deleteManySpy.mockRestore();
  });

  it("keeps the exit batch mode button visible when search hides all sessions", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /批量管理/i }));
    openSearch();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "NoSuchSession" },
    });

    await waitFor(() => expect(screen.queryByText("Alpha Session")).toBeNull());

    expect(screen.getByRole("button", { name: /退出批量管理/i })).toBeVisible();
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

    openSearch();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Alpha" },
    });

    await waitFor(() =>
      expect(screen.queryByText("Beta Session")).not.toBeInTheDocument(),
    );

    closeSearch();

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

    const dialog = screen.getByTestId("confirm-dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: /删除所选会话/i }),
    );

    await waitFor(() => {
      expect(screen.queryByText("Alpha Session")).not.toBeInTheDocument();
      expect(screen.queryByText("Beta Session")).not.toBeInTheDocument();
    });

    await act(async () => {
      resolveInvalidate();
    });
    invalidateSpy.mockRestore();
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
        name: /展开或折叠 codex 供应商分组/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /展开或折叠 claude 供应商分组/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /展开或折叠 codex 目录分组/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Alpha Session/ }),
    ).not.toBeInTheDocument();
  });

  it("persists manual expansion and collapses all grouped sessions", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    await switchToGroupedView();
    expandDirectoryGroup("codex", "codex");

    expect(
      screen.getByRole("button", { name: /展开或折叠 codex 目录分组/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Alpha Session/ }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem(GROUP_EXPANSION_STORAGE_KEY)!),
      ).toEqual({
        expandedProviderIds: ["codex"],
        expandedDirectoryKeys: ["codex:/mock/codex"],
      }),
    );

    collapseAllGroups();

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /展开或折叠 codex 目录分组/ }),
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
      screen.getByRole("button", {
        name: /展开或折叠 claude 供应商分组/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /展开或折叠 claude 目录分组/ }),
    ).not.toBeInTheDocument();

    expandDirectoryGroup("claude", "claude");

    expect(
      screen.getByRole("button", { name: /展开或折叠 claude 目录分组/ }),
    ).toBeInTheDocument();
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

    const dialog = screen.getByTestId("confirm-dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: /删除所选会话/i }),
    );

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
      name: /选择 codex 供应商分组内会话/,
    });
    const claudeProviderCheckbox = screen.getByRole("checkbox", {
      name: /选择 claude 供应商分组内会话/,
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
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    await enterGroupedBatchMode();
    expandDirectoryGroup("codex", "codex");

    const providerCheckbox = screen.getByRole("checkbox", {
      name: /选择 codex 供应商分组内会话/,
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
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    await enterGroupedBatchMode();
    expandDirectoryGroup("codex", "codex");

    fireEvent.click(screen.getAllByRole("checkbox", { name: "选择会话" })[0]);

    expect(
      screen.getByRole("checkbox", {
        name: /选择 codex 供应商分组内会话/,
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
    expandDirectoryGroup("codex", "codex");
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /选择 codex 目录分组内会话/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /批量删除/i }));

    const dialog = screen.getByTestId("confirm-dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: /删除所选会话/i }),
    );

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
