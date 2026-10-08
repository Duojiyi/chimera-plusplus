import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PiManagement } from "@/views/PiManagement";
import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";
import { piApi, type PiDocument, type PiDocumentKind } from "@/lib/api/pi";

vi.mock("@/hooks/useLightweightClose", () => ({
  useLightweightCloseBlocker: vi.fn(),
}));
vi.mock("@/lib/api/pi", () => ({ piApi: { read: vi.fn(), save: vi.fn() } }));
vi.mock("@/lib/api/settings", () => ({
  settingsApi: { openExternal: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    onConfirm,
    onCancel,
  }: {
    isOpen: boolean;
    title: string;
    onConfirm: () => void;
    onCancel: () => void;
  }) =>
    isOpen ? (
      <div role="dialog" aria-label={title}>
        <button onClick={onConfirm}>确认保存</button>
        <button onClick={onCancel}>取消</button>
      </div>
    ) : null,
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(piApi.read).mockImplementation(async (kind) => ({
    path: `/pi/${kind}.json`,
    revision: "revision-1",
    value:
      kind === "settings"
        ? {
            defaultProvider: "custom",
            defaultModel: "model-a",
            defaultThinkingLevel: "high",
            packages: ["npm:example@1.0.0"],
            futureSetting: { keep: true },
          }
        : { mcpServers: {}, futureMcpOption: 1 },
  }));
  vi.mocked(piApi.save).mockImplementation(async (kind, value) => ({
    path: `/pi/${kind}.json`,
    revision: "revision-2",
    value,
  }));
});
async function load() {
  render(<PiManagement native />);
  fireEvent.click(screen.getByRole("button", { name: "读取全局配置" }));
  await screen.findByDisplayValue("model-a");
}
describe("Pi management", () => {
  it.each<PiDocumentKind>(["settings", "mcp"])(
    "keeps the healthy editor usable when %s fails and retries only that document",
    async (failed) => {
      const healthy = failed === "settings" ? "mcp" : "settings";
      const read = vi.mocked(piApi.read).getMockImplementation()!;
      const healthyDocument = await read(healthy);
      const recoveredDocument = {
        ...(await read(failed)),
        revision: "recovered-revision",
      };
      vi.mocked(piApi.read).mockImplementation(async (kind) => {
        if (kind === failed) throw new Error(`broken ${failed}`);
        return healthyDocument;
      });
      render(<PiManagement native />);
      fireEvent.click(screen.getByRole("button", { name: "读取全局配置" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        `broken ${failed}`,
      );
      const label = healthy === "settings" ? "模型 ID" : "Pi MCP JSON";
      const draft =
        healthy === "settings"
          ? "healthy-draft"
          : JSON.stringify({
              ...healthyDocument.value,
              mcpServers: {
                local: { command: "example", futureServerOption: true },
              },
            });
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: draft },
      });
      expect(useLightweightCloseBlocker).toHaveBeenLastCalledWith(true);
      // A failed retry also leaves the healthy draft alone.
      const retryName =
        failed === "settings" ? "重试读取默认设置" : "重试读取 MCP";
      fireEvent.click(screen.getByRole("button", { name: retryName }));
      await screen.findByRole("alert");
      expect(screen.getByLabelText(label)).toHaveValue(draft);
      let resolveRetry!: (document: PiDocument) => void;
      vi.mocked(piApi.read).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRetry = resolve;
          }),
      );
      fireEvent.click(screen.getByRole("button", { name: retryName }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByLabelText(label)).toBeEnabled();
      // Saving the healthy document does not wait for the other read.
      fireEvent.click(
        screen.getByRole("button", {
          name: healthy === "settings" ? "保存默认设置" : "保存 MCP",
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      const expectedHealthy =
        healthy === "settings"
          ? { ...healthyDocument.value, defaultModel: draft }
          : JSON.parse(draft);
      expect(piApi.save).toHaveBeenLastCalledWith(
        healthy,
        expectedHealthy,
        "revision-1",
      );
      // Leave a new unsaved draft before the retry completes.
      const nextDraft =
        healthy === "settings"
          ? "still-unsaved"
          : JSON.stringify({ ...expectedHealthy, futureMcpOption: 2 });
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: nextDraft },
      });
      await act(async () => resolveRetry(recoveredDocument));
      expect(screen.getByLabelText(label)).toHaveValue(nextDraft);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(vi.mocked(piApi.read).mock.calls.map(([kind]) => kind)).toEqual([
        "settings",
        "mcp",
        failed,
        failed,
      ]);
      fireEvent.click(
        screen.getByRole("button", {
          name: failed === "settings" ? "保存默认设置" : "保存 MCP",
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(piApi.save).toHaveBeenLastCalledWith(
        failed,
        recoveredDocument.value,
        "recovered-revision",
      );
      expect(screen.getByLabelText(label)).toHaveValue(nextDraft);
      fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
      expect(
        screen.getByRole("dialog", { name: "放弃未保存草稿？" }),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
      expect(screen.getByLabelText(label)).toHaveValue(nextDraft);
    },
  );
  it.each<PiDocumentKind>(["settings", "mcp"])(
    "renders the healthy editor while %s is still loading",
    async (slow) => {
      const read = vi.mocked(piApi.read).getMockImplementation()!;
      let resolveSlow!: (document: PiDocument) => void;
      vi.mocked(piApi.read).mockImplementation((kind) =>
        kind === slow
          ? new Promise((resolve) => {
              resolveSlow = resolve;
            })
          : read(kind),
      );
      render(<PiManagement native />);
      expect(useLightweightCloseBlocker).toHaveBeenLastCalledWith(false);
      fireEvent.click(screen.getByRole("button", { name: "读取全局配置" }));
      expect(
        await screen.findByLabelText(
          slow === "settings" ? "Pi MCP JSON" : "模型 ID",
        ),
      ).toBeEnabled();
      expect(useLightweightCloseBlocker).toHaveBeenLastCalledWith(true);
      await act(async () => resolveSlow(await read(slow)));
      expect(useLightweightCloseBlocker).toHaveBeenLastCalledWith(false);
    },
  );
  it("blocks lightweight close during a save and releases it after the draft is saved", async () => {
    await load();
    let resolveSave!: (document: PiDocument) => void;
    vi.mocked(piApi.save).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    fireEvent.change(screen.getByLabelText("模型 ID"), {
      target: { value: "saved-model" },
    });
    expect(useLightweightCloseBlocker).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "保存默认设置" }));
    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
    expect(screen.getByLabelText("模型 ID")).toBeDisabled();
    expect(useLightweightCloseBlocker).toHaveBeenLastCalledWith(true);
    await act(async () =>
      resolveSave({
        path: "/pi/settings.json",
        revision: "saved",
        value: vi.mocked(piApi.save).mock.calls[0][1],
      }),
    );
    expect(useLightweightCloseBlocker).toHaveBeenLastCalledWith(false);
  });
  it.each<PiDocumentKind>(["settings", "mcp"])(
    "preserves both drafts and CAS after a %s save conflict; confirmed retry reloads only its target",
    async (kind) => {
      await load();
      const settingsDraft = "keep-settings";
      const mcpDraft = '{"mcpServers":{},"futureMcpOption":42}';
      fireEvent.change(screen.getByLabelText("模型 ID"), {
        target: { value: settingsDraft },
      });
      fireEvent.change(screen.getByLabelText("Pi MCP JSON"), {
        target: { value: mcpDraft },
      });
      vi.mocked(piApi.save).mockRejectedValue(new Error("external conflict"));
      for (let attempt = 0; attempt < 2; attempt++) {
        fireEvent.click(
          screen.getByRole("button", {
            name: kind === "settings" ? "保存默认设置" : "保存 MCP",
          }),
        );
        fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
        expect(await screen.findByRole("alert")).toHaveTextContent(
          "external conflict",
        );
        expect(piApi.save).toHaveBeenLastCalledWith(
          kind,
          expect.any(Object),
          "revision-1",
        );
        expect(screen.getByLabelText("模型 ID")).toHaveValue(settingsDraft);
        expect(screen.getByLabelText("Pi MCP JSON")).toHaveValue(mcpDraft);
      }
      const retryName =
        kind === "settings" ? "重试读取默认设置" : "重试读取 MCP";
      fireEvent.click(screen.getByRole("button", { name: retryName }));
      expect(
        screen.getByRole("dialog", { name: "放弃未保存草稿？" }),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
      expect(piApi.read).toHaveBeenCalledTimes(2);
      fireEvent.click(screen.getByRole("button", { name: retryName }));
      fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
      await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
      expect(piApi.read).toHaveBeenCalledTimes(3);
      expect(piApi.read).toHaveBeenLastCalledWith(kind);
      expect(
        screen.getByLabelText(kind === "settings" ? "Pi MCP JSON" : "模型 ID"),
      ).toHaveValue(kind === "settings" ? mcpDraft : settingsDraft);
      expect(useLightweightCloseBlocker).toHaveBeenLastCalledWith(true);
    },
  );
  it("reads only on demand and disables writes in browser preview", () => {
    render(<PiManagement native={false} />);
    expect(piApi.read).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "读取全局配置" })).toBeDisabled();
  });
  it("preserves packages and unknown settings, using the loaded revision and explicit consent", async () => {
    await load();
    fireEvent.change(screen.getByLabelText("模型 ID"), {
      target: { value: "model-b" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存默认设置" }));
    expect(piApi.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
    await waitFor(() =>
      expect(piApi.save).toHaveBeenCalledWith(
        "settings",
        {
          defaultProvider: "custom",
          defaultModel: "model-b",
          defaultThinkingLevel: "high",
          packages: ["npm:example@1.0.0"],
          futureSetting: { keep: true },
        },
        "revision-1",
      ),
    );
  });
  it("rejects invalid MCP data without a write", async () => {
    await load();
    fireEvent.change(screen.getByLabelText("Pi MCP JSON"), {
      target: { value: '{"mcpServers":[]}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存 MCP" }));
    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "mcpServers 必须是对象",
    );
    expect(piApi.save).not.toHaveBeenCalled();
  });
  it("retains drafts after an external edit conflict", async () => {
    await load();
    vi.mocked(piApi.save).mockRejectedValue(
      new Error("changed outside Chimera++"),
    );
    fireEvent.change(screen.getByLabelText("模型 ID"), {
      target: { value: "keep-draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存默认设置" }));
    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "changed outside",
    );
    expect(screen.getByLabelText("模型 ID")).toHaveValue("keep-draft");
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    expect(
      screen.getByRole("dialog", { name: "放弃未保存草稿？" }),
    ).toBeInTheDocument();
  });
  it("uses the saved revision for subsequent writes without rereading or discarding other drafts", async () => {
    await load();
    fireEvent.change(screen.getByLabelText("Pi MCP JSON"), {
      target: { value: '{"mcpServers":{"local":{"command":"example"}}}' },
    });
    fireEvent.change(screen.getByLabelText("模型 ID"), {
      target: { value: "model-b" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存默认设置" }));
    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(piApi.read).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("Pi MCP JSON")).toHaveValue(
      '{"mcpServers":{"local":{"command":"example"}}}',
    );
    fireEvent.change(screen.getByLabelText("模型 ID"), {
      target: { value: "model-c" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存默认设置" }));
    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
    await waitFor(() =>
      expect(piApi.save).toHaveBeenLastCalledWith(
        "settings",
        expect.objectContaining({ defaultModel: "model-c" }),
        "revision-2",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    expect(
      screen.getByRole("dialog", { name: "放弃未保存草稿？" }),
    ).toBeInTheDocument();
  });
  it("does not ask to discard a successfully saved draft", async () => {
    await load();
    fireEvent.change(screen.getByLabelText("模型 ID"), {
      target: { value: "model-b" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存默认设置" }));
    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await waitFor(() => expect(piApi.read).toHaveBeenCalledTimes(4));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
