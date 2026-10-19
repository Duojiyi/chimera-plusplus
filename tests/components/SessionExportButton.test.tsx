import { StrictMode } from "react";
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
import { toast } from "sonner";
import { SessionExportButton } from "@/components/sessions/SessionExportButton";
import { sessionsApi } from "@/lib/api/sessions";
import type { SessionMessage, SessionMeta } from "@/types";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api/sessions", () => ({
  sessionsApi: { exportFile: vi.fn() },
}));

const exportFile = vi.mocked(sessionsApi.exportFile);
const savedPath = "D:\\chosen folder\\conversation.md";
const sessionA: SessionMeta = {
  providerId: "codex",
  sessionId: "session-a",
  title: "Original session",
  sourcePath: "C:\\private\\rollout-a.jsonl",
};
const sessionB: SessionMeta = {
  ...sessionA,
  sessionId: "session-b",
  title: "Another session",
  sourcePath: "C:\\private\\rollout-b.jsonl",
};
const messages: SessionMessage[] = [
  { role: "user", content: "Original question", ts: 0 },
  { role: "tool", content: "TOKEN=secret", ts: 1 },
  { role: "assistant", content: "Original answer", ts: 2 },
];

const exportButton = (
  session = sessionA,
  content = messages,
  unavailableReason: string | null = null,
) => (
  <SessionExportButton
    session={session}
    messages={content}
    unavailableReason={unavailableReason}
  />
);

const openExport = async () => {
  await userEvent.click(screen.getByRole("button", { name: "导出" }));
  return screen.getByRole("dialog", { name: "导出会话" });
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  exportFile.mockReset().mockResolvedValue(savedPath);
});

describe("SessionExportButton", () => {
  it("defaults to Markdown, uses the native destination, and shows a persistent saved path", async () => {
    render(exportButton());
    const dialog = await openExport();
    expect(
      within(dialog).getByRole("button", { name: "Markdown" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(dialog).toHaveTextContent("由你选择文件夹和文件名");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "保存 Markdown…" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(savedPath);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(exportFile).toHaveBeenCalledTimes(1);
    const request = exportFile.mock.calls[0][0];
    expect(request).toMatchObject({
      fileName: "session-session-a.md",
      format: "markdown",
    });
    expect(request.content).toContain("Original question");
    expect(request.content).toContain("Original answer");
    expect(request.content).not.toContain("TOKEN=secret");
    expect(request.content).not.toContain(sessionA.sourcePath);
    expect(toast.success).toHaveBeenCalledWith(
      "会话导出成功",
      expect.objectContaining({
        description: expect.stringContaining(savedPath),
      }),
    );
  });

  it("can open and close from the keyboard and returns focus to the actual button", async () => {
    const user = userEvent.setup();
    render(exportButton());
    const trigger = screen.getByRole("button", { name: "导出" });
    await user.tab();
    expect(trigger).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "导出会话" })).toBeVisible();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.keyboard(" ");
    expect(screen.getByRole("dialog", { name: "导出会话" })).toBeVisible();
  });

  it("blocks duplicate saves synchronously, disables all controls, and cannot close mid-save", async () => {
    const pending = deferred<string | null>();
    exportFile.mockReturnValueOnce(pending.promise);
    render(exportButton());
    const dialog = await openExport();
    const save = within(dialog).getByRole("button", { name: "保存 Markdown…" });
    act(() => {
      fireEvent.click(save);
      fireEvent.click(save);
      fireEvent.click(save);
    });
    expect(exportFile).toHaveBeenCalledTimes(1);
    expect(save).toBeDisabled();
    expect(within(dialog).getByRole("checkbox")).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "JSON" })).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Markdown" }),
    ).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "保存中…" })).toHaveLength(2);
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeVisible();
    await act(async () => pending.resolve(savedPath));
    expect(screen.getByRole("button", { name: "导出" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent(savedPath);
  });

  it("does not report native cancellation as success and preserves options for retry", async () => {
    exportFile.mockResolvedValueOnce(null);
    render(exportButton());
    const dialog = await openExport();
    fireEvent.click(within(dialog).getByRole("button", { name: "JSON" }));
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存 JSON…" }));
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "保存 JSON…" }),
      ).toBeEnabled(),
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox")).toBeChecked();
    fireEvent.click(within(dialog).getByRole("button", { name: "保存 JSON…" }));
    expect(await screen.findByRole("status")).toHaveTextContent(savedPath);
    expect(exportFile).toHaveBeenCalledTimes(2);
    const request = exportFile.mock.calls[1][0];
    expect(request).toMatchObject({
      fileName: "session-session-a.json",
      format: "json",
    });
    expect(JSON.parse(request.content).messages).toEqual(messages);
  });

  it("reports failures with the originating session and allows a retry without reconfiguration", async () => {
    exportFile.mockRejectedValueOnce(new Error("disk full"));
    render(exportButton());
    const dialog = await openExport();
    fireEvent.click(within(dialog).getByRole("button", { name: "JSON" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存 JSON…" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith(
      "会话导出失败",
      expect.objectContaining({
        description: expect.stringContaining(
          "Original session（session-a）\nError: disk full",
        ),
      }),
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    const retry = within(dialog).getByRole("button", { name: "保存 JSON…" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(await screen.findByRole("status")).toHaveTextContent(savedPath);
    expect(exportFile).toHaveBeenCalledTimes(2);
  });

  it("requires a fresh tool-output opt-in after dismissing or successfully exporting", async () => {
    render(exportButton());
    let dialog = await openExport();
    fireEvent.click(within(dialog).getByRole("checkbox"));
    expect(within(dialog).getByRole("note")).toHaveTextContent(
      "分享文件前请逐条检查",
    );
    await userEvent.keyboard("{Escape}");
    dialog = await openExport();
    expect(within(dialog).getByRole("checkbox")).not.toBeChecked();
    expect(within(dialog).queryByRole("note")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "保存 Markdown…" }),
    );
    await screen.findByRole("status");
    expect(exportFile.mock.calls[0][0].content).toContain("TOKEN=secret");
    dialog = await openExport();
    expect(within(dialog).getByRole("checkbox")).not.toBeChecked();
  });

  it.each(["providerId", "sessionId", "sourcePath"] as const)(
    "clears saved paths and open options when %s changes",
    async (field) => {
      const { rerender } = render(exportButton());
      let dialog = await openExport();
      fireEvent.click(
        within(dialog).getByRole("button", { name: "保存 Markdown…" }),
      );
      await screen.findByRole("status");
      dialog = await openExport();
      fireEvent.click(within(dialog).getByRole("checkbox"));
      fireEvent.click(within(dialog).getByRole("button", { name: "JSON" }));
      rerender(exportButton({ ...sessionA, [field]: `changed-${field}` }));
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      dialog = await openExport();
      expect(within(dialog).getByRole("checkbox")).not.toBeChecked();
      expect(
        within(dialog).getByRole("button", { name: "Markdown" }),
      ).toHaveAttribute("aria-pressed", "true");
      await userEvent.keyboard("{Escape}");
      rerender(exportButton());
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    },
  );

  it("keeps an in-flight export bound to its snapshot without attaching the result to a different session", async () => {
    const pending = deferred<string | null>();
    exportFile.mockReturnValueOnce(pending.promise);
    const { rerender } = render(exportButton());
    const dialog = await openExport();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "保存 Markdown…" }),
    );
    rerender(
      exportButton(sessionB, [
        { role: "user", content: "NEW SESSION CONTENT" },
      ]),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存中…" })).toBeDisabled();
    await act(async () => pending.resolve(savedPath));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(exportFile.mock.calls[0][0].content).toContain("Original question");
    expect(exportFile.mock.calls[0][0].content).not.toContain(
      "NEW SESSION CONTENT",
    );
    expect(toast.success).toHaveBeenCalledWith(
      "会话导出成功",
      expect.objectContaining({
        description: expect.stringContaining("Original session（session-a）"),
      }),
    );
    expect(screen.getByRole("button", { name: "导出" })).toBeEnabled();
    const nextDialog = await openExport();
    expect(within(nextDialog).getByRole("checkbox")).not.toBeChecked();
    await userEvent.keyboard("{Escape}");
    rerender(exportButton());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("attributes an older save failure to its original session after navigation", async () => {
    const pending = deferred<string | null>();
    exportFile.mockReturnValueOnce(pending.promise);
    const { rerender } = render(exportButton());
    const dialog = await openExport();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "保存 Markdown…" }),
    );
    rerender(exportButton(sessionB));
    await act(async () => pending.reject(new Error("permission denied")));
    expect(toast.error).toHaveBeenCalledWith(
      "会话导出失败",
      expect.objectContaining({
        description: expect.stringContaining("Original session（session-a）"),
      }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出" })).toBeEnabled();
  });

  it.each(["success", "failure"])(
    "does not update or notify after unmount on %s",
    async (outcome) => {
      const pending = deferred<string | null>();
      exportFile.mockReturnValueOnce(pending.promise);
      const { unmount } = render(<StrictMode>{exportButton()}</StrictMode>);
      const dialog = await openExport();
      fireEvent.click(
        within(dialog).getByRole("button", { name: "保存 Markdown…" }),
      );
      unmount();
      await act(async () => {
        if (outcome === "success") pending.resolve(savedPath);
        else pending.reject(new Error("save failed"));
      });
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    },
  );

  it("disables an unavailable trigger and also rechecks availability while the popover is open", async () => {
    const { rerender } = render(exportButton(sessionA, messages, "读取中"));
    expect(screen.getByRole("button", { name: "导出" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "导出" })).toHaveAttribute(
      "title",
      "读取中",
    );
    rerender(exportButton());
    const dialog = await openExport();
    rerender(exportButton(sessionA, messages, "无法读取会话"));
    const save = within(dialog).getByRole("button", { name: "保存 Markdown…" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(exportFile).not.toHaveBeenCalled();
  });

  it("sanitizes and limits the suggested filename without changing exported content", async () => {
    const sessionId = `../../:*?<>|${"x".repeat(150)}`;
    render(exportButton({ ...sessionA, sessionId }));
    const dialog = await openExport();
    fireEvent.click(within(dialog).getByRole("button", { name: "JSON" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存 JSON…" }));
    await screen.findByRole("status");
    const request = exportFile.mock.calls[0][0];
    expect(request.fileName).toMatch(/^session-[a-zA-Z0-9_-]{100}\.json$/);
    expect(JSON.parse(request.content).session.sessionId).toBe(sessionId);
  });

  it("does not erase a previous successful destination when a later native save is cancelled", async () => {
    exportFile.mockResolvedValueOnce(savedPath).mockResolvedValueOnce(null);
    render(exportButton());
    let dialog = await openExport();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "保存 Markdown…" }),
    );
    await screen.findByRole("status");
    dialog = await openExport();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "保存 Markdown…" }),
    );
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "保存 Markdown…" }),
      ).toBeEnabled(),
    );
    expect(screen.getByRole("status")).toHaveTextContent(savedPath);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
});
