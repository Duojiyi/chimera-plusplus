import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImportPanel } from "@/components/settings/ImportPanel";
import { deeplinkApi } from "@/lib/api/deeplink";
vi.mock("@/lib/api/deeplink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/deeplink")>()),
  deeplinkApi: { submitImport: vi.fn() },
}));
beforeEach(() => vi.resetAllMocks());
describe("settings link import", () => {
  it("keeps native imports unavailable in the browser", () => {
    render(<ImportPanel native={false} />);
    expect(screen.getByLabelText("导入链接")).toBeDisabled();
    expect(screen.getByRole("button", { name: "预览并确认" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("浏览器预览");
    expect(deeplinkApi.submitImport).not.toHaveBeenCalled();
  });
  it("queues a trimmed link only once and clears its secret after submission", async () => {
    let finish!: () => void;
    vi.mocked(deeplinkApi.submitImport).mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const { container } = render(<ImportPanel native />);
    const input = screen.getByLabelText("导入链接");
    expect(input).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "预览并确认" })).toBeDisabled();
    fireEvent.change(input, {
      target: { value: "  chimera://v1/import?apiKey=secret  " },
    });
    fireEvent.submit(container.querySelector("form")!);
    fireEvent.submit(container.querySelector("form")!);
    expect(deeplinkApi.submitImport).toHaveBeenCalledTimes(1);
    expect(deeplinkApi.submitImport).toHaveBeenCalledWith(
      "chimera://v1/import?apiKey=secret",
    );
    expect(input).toBeDisabled();
    await act(async () => finish());
    expect(input).toHaveValue("");
    expect(screen.getByRole("status")).toHaveTextContent("此操作尚未导入");
    expect(container.textContent).not.toContain("apiKey=secret");
  });
  it("does not echo backend errors containing secrets and allows retry", async () => {
    vi.mocked(deeplinkApi.submitImport)
      .mockRejectedValueOnce(new Error("secret-key"))
      .mockResolvedValueOnce();
    render(<ImportPanel native />);
    fireEvent.change(screen.getByLabelText("导入链接"), {
      target: { value: "chimera://v1/import?apiKey=secret-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "预览并确认" }));
    expect(await screen.findByRole("alert")).not.toHaveTextContent(
      "secret-key",
    );
    fireEvent.click(screen.getByRole("button", { name: "预览并确认" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("已加入待确认队列"),
    );
    expect(deeplinkApi.submitImport).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["DEEP_LINK_PARSE_FAILED", "无法使用这个导入链接"],
    ["DEEP_LINK_TARGET_UNAVAILABLE", "链接要导入到的工具在当前版本不可用"],
    ["DEEP_LINK_QUEUE_FULL", "请先处理已打开的导入确认"],
  ])("says why the backend refused the link (%s)", async (code, text) => {
    // Tauri rejects with the command's error string as is.
    vi.mocked(deeplinkApi.submitImport).mockRejectedValueOnce(code);
    render(<ImportPanel native />);
    fireEvent.change(screen.getByLabelText("导入链接"), {
      target: { value: "chimera://v1/import?resource=provider" },
    });
    fireEvent.click(screen.getByRole("button", { name: "预览并确认" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(text);
    expect(alert).not.toHaveTextContent(code);
    expect(alert).toHaveClass("is-error");
  });
  it("treats a queued link whose confirmation did not open as queued", async () => {
    vi.mocked(deeplinkApi.submitImport).mockRejectedValueOnce(
      "IMPORT_NOTIFICATION_FAILED",
    );
    render(<ImportPanel native />);
    const input = screen.getByLabelText("导入链接");
    fireEvent.change(input, {
      target: { value: "chimera://v1/import?resource=provider" },
    });
    fireEvent.click(screen.getByRole("button", { name: "预览并确认" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "已加入待确认队列",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(input).toHaveValue("");
  });
});
