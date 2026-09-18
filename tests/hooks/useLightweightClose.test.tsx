import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  dialogs: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@/hooks/useDialogFocus", () => ({ openDialogCount: mocks.dialogs }));
vi.mock("sonner", () => ({ toast: { error: mocks.error } }));
import {
  useLightweightClose,
  useLightweightCloseBlocker,
} from "@/hooks/useLightweightClose";
let close: () => Promise<void>;
beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.error.mockClear();
  mocks.dialogs.mockReturnValue(0);
  mocks.unlisten.mockClear();
  mocks.listen.mockReset().mockImplementation(async (_event, callback) => {
    close = callback;
    return mocks.unlisten;
  });
});
describe("lightweight close safety", () => {
  it("releases an idle frontend", async () => {
    renderHook(() => useLightweightClose(false));
    await act(async () => close());
    expect(mocks.invoke).toHaveBeenCalledWith("enter_lightweight_mode");
  });
  it("keeps editor and active operation state alive, then releases when idle", async () => {
    const { rerender } = renderHook(({ busy }) => useLightweightClose(busy), {
      initialProps: { busy: true },
    });
    await act(async () => close());
    expect(mocks.invoke).toHaveBeenLastCalledWith("hide_main_window");
    rerender({ busy: false });
    await act(async () => close());
    expect(mocks.invoke).toHaveBeenLastCalledWith("enter_lightweight_mode");
  });
  it("respects child-page blockers and removes them on unmount", async () => {
    renderHook(() => useLightweightClose(false));
    const child = renderHook(() => useLightweightCloseBlocker(true));
    await act(async () => close());
    expect(mocks.invoke).toHaveBeenLastCalledWith("hide_main_window");
    child.unmount();
    await act(async () => close());
    expect(mocks.invoke).toHaveBeenLastCalledWith("enter_lightweight_mode");
  });
  it("keeps open dialogs alive", async () => {
    mocks.dialogs.mockReturnValue(1);
    renderHook(() => useLightweightClose(false));
    await act(async () => close());
    expect(mocks.invoke).toHaveBeenCalledWith("hide_main_window");
  });
  it("reports errors and permits retry", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("destroy failed"));
    renderHook(() => useLightweightClose(false));
    await act(async () => close());
    expect(mocks.error).toHaveBeenCalled();
    await act(async () => close());
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });
  it("ignores repeated close requests and cleans up the listener", async () => {
    let finish!: () => void;
    mocks.invoke.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { unmount } = renderHook(() => useLightweightClose(false));
    let pending!: Promise<void>;
    await act(async () => {
      pending = close();
      await close();
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
      await pending;
    });
    unmount();
    await waitFor(() => expect(mocks.unlisten).toHaveBeenCalledTimes(1));
    await close();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
});
