import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@tauri-apps/api/event";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  dialogs: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@/hooks/useDialogFocus", () => ({ openDialogCount: mocks.dialogs }));
vi.mock("sonner", () => ({ toast: { error: mocks.error, info: mocks.info } }));
import {
  useLightweightClose,
  useLightweightCloseBlocker,
  type LightweightCloseRequest,
} from "@/hooks/useLightweightClose";
const closeArgs = { mainActivation: 42 };
let close: (fromTray?: boolean, activation?: number) => Promise<void>;
beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.error.mockClear();
  mocks.info.mockClear();
  mocks.dialogs.mockReturnValue(0);
  mocks.unlisten.mockClear();
  mocks.listen.mockReset().mockImplementation(async (_event, callback) => {
    close = (fromTray = false, mainActivation = closeArgs.mainActivation) => {
      const event: Event<LightweightCloseRequest> = {
        event: "request-lightweight-close",
        id: 1,
        payload: { fromTray, mainActivation },
      };
      return callback(event);
    };
    return mocks.unlisten;
  });
});
describe("lightweight close safety", () => {
  it("releases an idle frontend", async () => {
    renderHook(() => useLightweightClose(false));
    await act(async () => close());
    expect(mocks.invoke).toHaveBeenCalledWith(
      "enter_lightweight_mode",
      closeArgs,
    );
  });
  it("keeps editor and active operation state alive, then releases when idle", async () => {
    const { rerender } = renderHook(({ busy }) => useLightweightClose(busy), {
      initialProps: { busy: true },
    });
    await act(async () => close());
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "hide_main_window",
      closeArgs,
    );
    rerender({ busy: false });
    await act(async () => close());
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "enter_lightweight_mode",
      closeArgs,
    );
  });
  it("respects child-page blockers and removes them on unmount", async () => {
    renderHook(() => useLightweightClose(false));
    const child = renderHook(() => useLightweightCloseBlocker(true));
    await act(async () => close());
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "hide_main_window",
      closeArgs,
    );
    child.unmount();
    await act(async () => close());
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "enter_lightweight_mode",
      closeArgs,
    );
  });
  it("keeps open dialogs alive", async () => {
    mocks.dialogs.mockReturnValue(1);
    renderHook(() => useLightweightClose(false));
    await act(async () => close());
    expect(mocks.invoke).toHaveBeenCalledWith("hide_main_window", closeArgs);
  });
  it("keeps unsaved edits visible when toggled from the tray", async () => {
    const { rerender } = renderHook(({ busy }) => useLightweightClose(busy), {
      initialProps: { busy: true },
    });
    await act(async () => close(true));
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(
      "show_main_window",
      closeArgs,
    );
    expect(mocks.info).toHaveBeenCalledTimes(1);
    rerender({ busy: false });
    await act(async () => close(true));
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "enter_lightweight_mode",
      closeArgs,
    );
  });
  it("reports errors and permits retry", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("destroy failed"));
    renderHook(() => useLightweightClose(false));
    await act(async () => close());
    expect(mocks.error).toHaveBeenCalled();
    await act(async () => close());
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });
  it("honors a new close after a restore and protects input while closing", async () => {
    const finish = new Map<number, () => void>();
    mocks.invoke.mockImplementation(
      (_, { mainActivation }) =>
        new Promise<void>((resolve) => {
          finish.set(mainActivation, resolve);
        }),
    );
    renderHook(() => useLightweightClose(false));
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = close(false, 42);
      second = close(false, 43);
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "enter_lightweight_mode", {
      mainActivation: 43,
    });
    expect(document.body).toHaveAttribute("inert");
    await act(async () => {
      finish.get(42)!();
      await first;
    });
    expect(document.body).toHaveAttribute("inert");
    await act(async () => {
      finish.get(43)!();
      await second;
    });
    expect(document.body).not.toHaveAttribute("inert");
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
