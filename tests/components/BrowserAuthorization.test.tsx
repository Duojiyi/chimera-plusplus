import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthorizationLink,
  ManualAuthorization,
} from "@/components/accounts/BrowserAuthorization";
import { copyText } from "@/lib/clipboard";
import { settingsApi } from "@/lib/api/settings";

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("@/lib/api/settings", () => ({
  settingsApi: { openExternal: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

beforeEach(() => vi.resetAllMocks());

describe("browser authorization fallback", () => {
  it("copies and reopens exactly the current authorization link", async () => {
    const url =
      "https://claude.ai/oauth/authorize?state=current&code_challenge=challenge";
    render(<AuthorizationLink url={url} />);
    const field = screen.getByRole("textbox", { name: "授权链接" });
    expect(field).toHaveValue(url);
    expect(field).toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("button", { name: "复制授权链接" }));
    fireEvent.click(screen.getByRole("button", { name: "重新打开浏览器" }));
    expect(copyText).toHaveBeenCalledExactlyOnceWith(url);
    expect(settingsApi.openExternal).toHaveBeenCalledExactlyOnceWith(url);
    await act(async () => {});
  });

  it("keeps the selectable link when automatic copy fails", async () => {
    vi.mocked(copyText).mockRejectedValueOnce(new Error("剪贴板不可用"));
    render(
      <AuthorizationLink url="https://auth.openai.com/oauth/authorize?state=current" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "复制授权链接" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "复制失败：剪贴板不可用",
    );
    expect(screen.getByRole("textbox", { name: "授权链接" })).toBeVisible();
  });

  it("prevents repeated pending submissions and isolates a replacement flow", async () => {
    let rejectOld!: (error: Error) => void;
    const oldSubmit = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    const newSubmit = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <ManualAuthorization key="old" mode="claude" onSubmit={oldSubmit} />,
    );
    const field = screen.getByRole("textbox", { name: "授权码或回调地址" });
    fireEvent.change(field, { target: { value: "code#old" } });
    const submit = screen.getByRole("button", { name: "提交授权结果" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(oldSubmit).toHaveBeenCalledOnce();
    expect(submit).toBeDisabled();
    view.rerender(
      <ManualAuthorization key="new" mode="claude" onSubmit={newSubmit} />,
    );
    await act(async () => {
      rejectOld(new Error("old flow cancelled"));
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "授权码或回调地址" }),
    ).toHaveValue("");
    expect(screen.getByRole("button", { name: "提交授权结果" })).toBeDisabled();
  });
});
