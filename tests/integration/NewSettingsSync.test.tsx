import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
  return { get: vi.fn(), panel: vi.fn() };
});
vi.mock("@/lib/api/settings", () => ({
  settingsApi: { get: mocks.get, getAutoLaunchStatus: async () => false },
}));
vi.mock("@/lib/updater", () => ({ getCurrentVersion: async () => "test" }));
vi.mock("@/contexts/UpdateContext", () => ({ useUpdate: () => ({}) }));
vi.mock("@/components/theme-provider", () => ({
  useTheme: () => ({ theme: "light", setTheme: vi.fn() }),
}));
vi.mock("@/components/settings/SyncPanel", () => ({
  SyncPanel: (props: { onRefresh: () => Promise<void> }) => {
    mocks.panel();
    return <button onClick={() => void props.onRefresh()}>mock refresh</button>;
  },
}));
import { NewSettingsView } from "@/views/NewSettingsView";
beforeEach(() => {
  window.history.replaceState(null, "", "#settings-backups");
  mocks.get.mockReset().mockResolvedValue({});
  mocks.panel.mockClear();
});
it("does not expose cloud sync even when legacy settings enable it", async () => {
  mocks.get.mockResolvedValue({
    webdavSync: { enabled: true, autoSync: true },
    s3Sync: { enabled: true, autoSync: true },
  });
  render(<NewSettingsView />);
  await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("button", { name: /WebDAV|S3/ })).toBeNull();
  expect(
    screen.getByRole("button", { name: "应用数据库备份与恢复" }),
  ).toBeEnabled();
  expect(mocks.panel).not.toHaveBeenCalled();
});
it("does not expose a usable sync panel before settings are loaded", () => {
  mocks.get.mockReturnValue(new Promise(() => {}));
  render(<NewSettingsView />);
  expect(screen.queryByRole("button", { name: /WebDAV|S3/ })).toBeNull();
  expect(mocks.panel).not.toHaveBeenCalled();
});
