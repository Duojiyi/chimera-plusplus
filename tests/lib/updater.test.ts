import { checkForUpdate } from "@/lib/updater";

const { checkMock, closeMock } = vi.hoisted(() => ({
  checkMock: vi.fn(),
  closeMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: checkMock,
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("2.8.4"),
}));

describe("checkForUpdate", () => {
  beforeEach(() => {
    closeMock.mockResolvedValue(undefined);
  });

  it("reads the release notes from the plugin's body and releases the resource", async () => {
    checkMock.mockResolvedValue({
      version: "2.8.5",
      date: "2026-10-13T08:00:00Z",
      body: "修复线路切换后的重启提示",
      close: closeMock,
    });

    const result = await checkForUpdate();

    expect(result).toEqual({
      status: "available",
      info: {
        currentVersion: "2.8.4",
        availableVersion: "2.8.5",
        notes: "修复线路切换后的重启提示",
        pubDate: "2026-10-13T08:00:00Z",
      },
    });
    expect(closeMock).toHaveBeenCalledOnce();
  });

  it("reports up to date without touching any resource", async () => {
    checkMock.mockResolvedValue(null);

    await expect(checkForUpdate()).resolves.toEqual({ status: "up-to-date" });
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("still returns the update when releasing the resource fails", async () => {
    closeMock.mockRejectedValue(new Error("resource already closed"));
    checkMock.mockResolvedValue({
      version: "2.8.5",
      body: undefined,
      close: closeMock,
    });

    const result = await checkForUpdate({ timeout: 1000 });

    expect(result.status).toBe("available");
    expect(checkMock).toHaveBeenCalledWith({ timeout: 1000 });
  });
});
