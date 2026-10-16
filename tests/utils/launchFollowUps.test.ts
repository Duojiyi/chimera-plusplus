import { beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({
  info: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));

import { notifyLaunchFollowUps } from "@/ChimeraApp";

const launch = (
  extra: Partial<Parameters<typeof notifyLaunchFollowUps>[0]> = {},
) => ({
  wasRunning: false,
  running: true,
  action: "launched" as const,
  modelUnlockAttempted: false,
  modelUnlockInjected: false,
  modelUnlockModelCount: 0,
  ...extra,
});

const deferred = {
  state: "deferred",
  message: "Codex 正在运行，关闭后再打开即可升级目录结构。",
};

describe("notifyLaunchFollowUps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A completed migration resets what this session has already shown.
    notifyLaunchFollowUps(
      launch({ layoutMigration: { state: "migrated", message: "reset" } }),
    );
    vi.clearAllMocks();
  });

  it("warns about a deferred layout migration once per session", () => {
    notifyLaunchFollowUps(launch({ layoutMigration: deferred }));
    notifyLaunchFollowUps(launch({ layoutMigration: deferred }));
    notifyLaunchFollowUps(launch({ layoutMigration: deferred }));

    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith("免安装版目录结构未升级", {
      description: deferred.message,
    });
  });

  it("warns again when the reason changes", () => {
    notifyLaunchFollowUps(launch({ layoutMigration: deferred }));
    notifyLaunchFollowUps(
      launch({
        layoutMigration: { state: "failed", message: "目录被占用，已恢复原状。" },
      }),
    );

    expect(toast.warning).toHaveBeenCalledTimes(2);
  });

  it("reports a finished migration and warns again after a later deferral", () => {
    notifyLaunchFollowUps(launch({ layoutMigration: deferred }));
    notifyLaunchFollowUps(
      launch({ layoutMigration: { state: "migrated", message: "已更新。" } }),
    );
    notifyLaunchFollowUps(launch({ layoutMigration: deferred }));

    expect(toast.info).toHaveBeenCalledWith("免安装版目录结构已更新", {
      description: "已更新。",
    });
    expect(toast.warning).toHaveBeenCalledTimes(2);
  });

  it("stays silent when no migration was needed", () => {
    notifyLaunchFollowUps(
      launch({ layoutMigration: { state: "not-needed", message: "" } }),
    );
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("tells the user a slow start is a launch, not a failure", () => {
    notifyLaunchFollowUps(
      launch({ startupSlow: true, startupNotice: "Codex 仍在启动。" }),
    );
    expect(toast.warning).toHaveBeenCalledWith("Codex 启动较慢", {
      description: "Codex 仍在启动。",
    });
    expect(toast.error).not.toHaveBeenCalled();
  });
});
