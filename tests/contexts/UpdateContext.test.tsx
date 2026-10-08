import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_POLL_MS,
  UpdateProvider,
  useUpdate,
  type UpdateContextValue,
} from "@/contexts/UpdateContext";

const { checkForUpdateMock } = vi.hoisted(() => ({
  checkForUpdateMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
}));

vi.mock("@/lib/updater", () => ({
  checkForUpdate: checkForUpdateMock,
}));

vi.mock("@/lib/api/settings", () => ({
  settingsApi: {
    stageUpdateDownload: vi.fn().mockResolvedValue("2.0.0"),
  },
}));

let update: UpdateContextValue;

function UpdateProbe() {
  update = useUpdate();
  const { lastCheckedAt } = update;
  return <output>{lastCheckedAt ?? "never"}</output>;
}

describe("UpdateProvider periodic checks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T00:00:00Z"));
    localStorage.clear();
    checkForUpdateMock.mockResolvedValue({ status: "up-to-date" });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("checks again when a hidden app becomes visible after the interval", async () => {
    render(
      <UpdateProvider>
        <UpdateProbe />
      </UpdateProvider>,
    );

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(checkForUpdateMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).not.toHaveTextContent("never");

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    await act(async () => {
      vi.advanceTimersByTime(6 * 60 * 60 * 1000);
    });
    expect(checkForUpdateMock).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });

    expect(checkForUpdateMock).toHaveBeenCalledTimes(2);
  });

  it("checks again about 15 minutes later while the app stays visible", async () => {
    render(
      <UpdateProvider>
        <UpdateProbe />
      </UpdateProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(checkForUpdateMock).toHaveBeenCalledTimes(1);

    // Well short of the interval: must not fire yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    });
    expect(checkForUpdateMock).toHaveBeenCalledTimes(1);

    // Past the interval (plus one poll period, so a tick is guaranteed to land
    // beyond the threshold): now it must fire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        UPDATE_CHECK_INTERVAL_MS - 10 * 60 * 1000 + UPDATE_CHECK_POLL_MS,
      );
    });
    expect(checkForUpdateMock).toHaveBeenCalledTimes(2);
  });

  // Guards the drift trap documented on UPDATE_CHECK_POLL_MS: if the poll period
  // is ever raised to equal the interval, timer drift makes each tick land just
  // short of the threshold, it skips, and the effective spacing silently
  // doubles. Fake timers are exact, so no behavioural test can catch this —
  // only the arithmetic relationship can.
  it("polls strictly more often than the staleness threshold", () => {
    expect(UPDATE_CHECK_POLL_MS).toBeLessThan(UPDATE_CHECK_INTERVAL_MS);
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(15 * 60 * 1000);
  });
});

const LAST_CHECKED_KEY = "chimera:update:lastCheckedAt";
const LEGACY_LAST_CHECKED_KEY = "ccswitch:update:lastCheckedAt";
const DISMISSED_VERSION_KEY = "chimera:update:dismissedVersion";
const LEGACY_DISMISSED_KEYS = [
  "ccswitch:update:dismissedVersion",
  "dismissedUpdateVersion",
];
const available = {
  status: "available",
  info: { currentVersion: "1.0.0", availableVersion: "2.0.0" },
};

function renderUpdate() {
  return render(
    <UpdateProvider>
      <UpdateProbe />
    </UpdateProvider>,
  );
}

function storageFailure(): never {
  throw new DOMException("Storage unavailable", "SecurityError");
}

describe("UpdateProvider storage failures", () => {
  const storageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  )!;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T00:00:00Z"));
    localStorage.clear();
    checkForUpdateMock.mockResolvedValue(available);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", storageDescriptor);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(["access", "getItem", "setItem"] as const)(
    "keeps startup, checking, reminders and polling working when %s throws",
    async (failure) => {
      if (failure === "access") {
        Object.defineProperty(globalThis, "localStorage", {
          configurable: true,
          get: storageFailure,
        });
      } else {
        vi.spyOn(localStorage, failure).mockImplementation(storageFailure);
      }
      renderUpdate();
      expect(update.lastCheckedAt).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(update.hasUpdate).toBe(true);
      expect(update.updateInfo).toEqual(available.info);
      expect(update.lastCheckedAt).toBe(Date.now());
      expect(update.isChecking).toBe(false);
      expect(update.error).toBeNull();
      expect(update.errorOperation).toBeNull();

      act(() => update.dismissUpdate());
      expect(update.isDismissed).toBe(true);
      await act(async () => {
        await expect(update.checkUpdate()).resolves.toBe(true);
      });
      expect(update.isDismissed).toBe(true);
      act(() => update.resetDismiss());
      expect(update.isDismissed).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(checkForUpdateMock).toHaveBeenCalledTimes(2);
      checkForUpdateMock.mockResolvedValue({ status: "up-to-date" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + UPDATE_CHECK_POLL_MS);
      });
      expect(checkForUpdateMock).toHaveBeenCalledTimes(3);
      expect(update.hasUpdate).toBe(false);
      expect(update.updateInfo).toBeNull();
      expect(update.lastCheckedAt).toBeGreaterThan(
        Date.now() - UPDATE_CHECK_POLL_MS,
      );
      expect(update.error).toBeNull();
      expect(update.errorOperation).toBeNull();
    },
  );

  it.each([false, true])(
    "preserves the migrated timestamp in memory (write fails: %s)",
    (fails) => {
      const timestamp = Date.now() - 1000;
      localStorage.setItem(LEGACY_LAST_CHECKED_KEY, String(timestamp));
      if (fails)
        vi.spyOn(localStorage, "setItem").mockImplementation(storageFailure);
      renderUpdate();
      expect(update.lastCheckedAt).toBe(timestamp);
      expect(localStorage.getItem(LAST_CHECKED_KEY)).toBe(
        fails ? null : String(timestamp),
      );
      expect(localStorage.getItem(LEGACY_LAST_CHECKED_KEY)).toBe(
        fails ? String(timestamp) : null,
      );
    },
  );

  it.each(LEGACY_DISMISSED_KEYS)(
    "retains %s until migration writes successfully",
    async (key) => {
      localStorage.setItem(key, "2.0.0");
      const write = vi
        .spyOn(localStorage, "setItem")
        .mockImplementation(storageFailure);
      const first = renderUpdate();
      await act(async () => {
        await expect(update.checkUpdate()).resolves.toBe(true);
      });
      expect(update.isDismissed).toBe(true);
      expect(localStorage.getItem(key)).toBe("2.0.0");
      expect(localStorage.getItem(DISMISSED_VERSION_KEY)).toBeNull();
      act(() => update.dismissUpdate());
      expect(localStorage.getItem(key)).toBe("2.0.0");
      expect(update.error).toBeNull();
      expect(update.errorOperation).toBeNull();

      first.unmount();
      write.mockRestore();
      renderUpdate();
      await act(async () => {
        await expect(update.checkUpdate()).resolves.toBe(true);
      });
      expect(update.isDismissed).toBe(true);
      expect(localStorage.getItem(DISMISSED_VERSION_KEY)).toBe("2.0.0");
      expect(localStorage.getItem(key)).toBeNull();
    },
  );

  it("remembers a loaded dismissal when storage later becomes unavailable", async () => {
    localStorage.setItem(DISMISSED_VERSION_KEY, "2.0.0");
    renderUpdate();
    await act(async () => {
      await update.checkUpdate();
    });
    expect(update.isDismissed).toBe(true);
    vi.spyOn(localStorage, "getItem").mockImplementation(storageFailure);
    await act(async () => {
      await expect(update.checkUpdate()).resolves.toBe(true);
    });
    expect(update.isDismissed).toBe(true);
    checkForUpdateMock.mockResolvedValue({
      ...available,
      info: { ...available.info, availableVersion: "3.0.0" },
    });
    await act(async () => {
      await expect(update.checkUpdate()).resolves.toBe(true);
    });
    expect(update.isDismissed).toBe(false);
    expect(update.error).toBeNull();
    expect(update.errorOperation).toBeNull();
  });

  it("keeps migration and reset state when removal fails", async () => {
    const timestamp = Date.now() - 1000;
    localStorage.setItem(LEGACY_LAST_CHECKED_KEY, String(timestamp));
    localStorage.setItem(LEGACY_DISMISSED_KEYS[0], "2.0.0");
    vi.spyOn(localStorage, "removeItem").mockImplementation(storageFailure);
    renderUpdate();
    expect(update.lastCheckedAt).toBe(timestamp);
    expect(localStorage.getItem(LAST_CHECKED_KEY)).toBe(String(timestamp));
    await act(async () => {
      await expect(update.checkUpdate()).resolves.toBe(true);
    });
    expect(update.isDismissed).toBe(true);
    expect(localStorage.getItem(DISMISSED_VERSION_KEY)).toBe("2.0.0");
    act(() => update.dismissUpdate());
    act(() => update.resetDismiss());
    expect(update.isDismissed).toBe(false);
    await act(async () => {
      await expect(update.checkUpdate()).resolves.toBe(true);
    });
    expect(update.isDismissed).toBe(false);
    expect(update.error).toBeNull();
    expect(update.errorOperation).toBeNull();
  });
});
