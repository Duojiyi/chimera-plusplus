import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PropsWithChildren } from "react";
import { useBackupManager } from "@/hooks/useBackupManager";
import {
  PartialBackupRestoreError,
  restoreDatabaseBackup,
} from "@/lib/api/config";
import { backupsApi } from "@/lib/api/settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);
const partial = {
  dbRestored: true,
  backupId: "safety-123",
  warning: "Live write failed",
  message: "数据库已恢复，但 Live/运行态同步未完成（部分成功）。不要重复恢复。",
};

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { ...renderHook(() => useBackupManager(), { wrapper }), invalidate };
}

function mockRestore(value: string | object, fail = false) {
  invokeMock.mockImplementation(async (command) => {
    if (command === "list_db_backups") return [];
    if (command === "restore_db_backup") {
      if (fail) throw value;
      return value;
    }
    throw new Error(`Unexpected command: ${command}`);
  });
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("backup restore outcome contract", () => {
  it.each(["safety-123", ""])(
    "preserves complete-success backup ID %j and refreshes queries",
    async (id) => {
      mockRestore(id);
      const { result, invalidate } = setup();
      let restored;
      await act(async () => {
        restored = await result.current.restore("old.db");
      });
      expect(restored).toBe(id);
      expect(invokeMock).toHaveBeenCalledWith("restore_db_backup", {
        filename: "old.db",
      });
      expect(invalidate).toHaveBeenCalledOnce();
      expect(
        invokeMock.mock.calls.filter(
          ([command]) => command === "list_db_backups",
        ).length,
      ).toBeGreaterThan(1);
    },
  );

  it("refreshes the changed DB but rejects partial success instead of reaching the caller's success branch", async () => {
    mockRestore(partial, true);
    const { result, invalidate } = setup();
    const fullSuccess = vi.fn();
    const failure = vi.fn();
    await act(async () => {
      await result.current.restore("old.db").then(fullSuccess, failure);
    });
    expect(fullSuccess).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledWith(expect.any(PartialBackupRestoreError));
    expect(failure.mock.calls[0][0]).toMatchObject(partial);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(
      invokeMock.mock.calls.filter(
        ([command]) => command === "restore_db_backup",
      ),
    ).toHaveLength(1);
  });

  it.each([
    "请先停止代理；数据库尚未修改",
    "备份包含代理接管状态",
    "Invalid backup filename",
  ])(
    "does not claim DB changed on pre-commit rejection: %s",
    async (message) => {
      mockRestore(message, true);
      const { result, invalidate } = setup();
      await act(async () => {
        await expect(result.current.restore("old.db")).rejects.toBe(message);
      });
      expect(invalidate).not.toHaveBeenCalled();
    },
  );

  it("does not hide a partial-success warning when query refresh also fails", async () => {
    mockRestore(partial, true);
    const { result, invalidate } = setup();
    invalidate.mockRejectedValueOnce(new Error("refresh failed"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await act(async () => {
        await expect(result.current.restore("old.db")).rejects.toMatchObject(
          partial,
        );
      });
      expect(log).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });

  it("keeps legacy transport callers rejected on partial success, with a readable message", async () => {
    mockRestore(partial, true);
    await expect(backupsApi.restoreDbBackup("old.db")).rejects.toEqual(partial);
    await expect(restoreDatabaseBackup("old.db")).rejects.toThrow(
      partial.message,
    );
  });

  it("provides an actionable fallback for a partial restore missing optional details", async () => {
    mockRestore({ dbRestored: true }, true);
    await expect(restoreDatabaseBackup("old.db")).rejects.toMatchObject({
      dbRestored: true,
      backupId: "",
      warning: "",
      message: expect.stringContaining("不要重复恢复"),
    });
  });
});
