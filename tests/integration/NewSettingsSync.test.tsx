import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
  return { get: vi.fn() };
});
vi.mock("@/lib/api/settings", () => ({
  settingsApi: { get: mocks.get, getAutoLaunchStatus: async () => false },
}));
vi.mock("@/lib/updater", () => ({ getCurrentVersion: async () => "test" }));
vi.mock("@/contexts/UpdateContext", () => ({ useUpdate: () => ({}) }));
vi.mock("@/components/theme-provider", () => ({
  useTheme: () => ({ theme: "light", setTheme: vi.fn() }),
}));
import { NewSettingsView } from "@/views/NewSettingsView";
beforeEach(() => {
  window.history.replaceState(null, "", "#settings-backups");
  mocks.get.mockReset().mockResolvedValue({});
});
it("does not expose cloud sync even when legacy settings enable it", async () => {
  mocks.get.mockResolvedValue({
    webdavSync: { enabled: true, autoSync: true },
    s3Sync: { enabled: true, autoSync: true },
  });
  render(<NewSettingsView />);
  await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
  // Settings opens at 工具 whatever the hash says; go to the backups section.
  fireEvent.click(screen.getByRole("link", { name: "备份与恢复" }));
  expect(screen.queryByRole("button", { name: /WebDAV|S3/ })).toBeNull();
  expect(screen.getByRole("button", { name: "应用数据库" })).toBeEnabled();
});
it("does not expose a usable sync panel before settings are loaded", () => {
  mocks.get.mockReturnValue(new Promise(() => {}));
  render(<NewSettingsView />);
  expect(screen.queryByRole("button", { name: /WebDAV|S3/ })).toBeNull();
});
