import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { liveBackupsApi } from "@/lib/api/liveBackups";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
describe("live backup IPC contract", () => {
  it("uses registered commands and sends IDs rather than backup paths or contents", async () => {
    await liveBackupsApi.openDirectory("codex");
    expect(invoke).toHaveBeenLastCalledWith("open_live_backup_directory", { app: "codex" });
    await liveBackupsApi.list("codex");
    expect(invoke).toHaveBeenLastCalledWith("list_live_backups", {
      app: "codex",
    });
    await liveBackupsApi.create("codex");
    expect(invoke).toHaveBeenLastCalledWith("create_live_backup", {
      app: "codex",
    });
    await liveBackupsApi.restore("codex", "id");
    expect(invoke).toHaveBeenLastCalledWith("restore_live_backup", {
      app: "codex",
      id: "id",
    });
    await liveBackupsApi.delete("codex", "id");
    expect(invoke).toHaveBeenLastCalledWith("delete_live_backup", {
      app: "codex",
      id: "id",
    });
  });
});
