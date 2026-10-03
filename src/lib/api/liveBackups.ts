import { invoke } from "@tauri-apps/api/core";
import type { AppId } from "./types";

export interface LiveBackup {
  id: string;
  app: string;
  createdAt: number;
  reason:
    | "manual"
    | "firstWrite"
    | "firstEnable"
    | "preRestore"
    | "preImport"
    | "prePrompt"
    | "preRepair";
  files: string[];
  identityFingerprint: string | null;
  sizeBytes?: number | null;
  path: string;
}
export interface LiveRestoreResult {
  restored: string[];
  preRestoreBackupId: string | null;
  identityChanged: boolean;
}
export const liveBackupsApi = {
  openDirectory: (app: AppId) =>
    invoke<void>("open_live_backup_directory", { app }),
  list: (app: AppId) => invoke<LiveBackup[]>("list_live_backups", { app }),
  create: (app: AppId) =>
    invoke<LiveBackup | null>("create_live_backup", { app }),
  restore: (app: AppId, id: string) =>
    invoke<LiveRestoreResult>("restore_live_backup", { app, id }),
  delete: (app: AppId, id: string) =>
    invoke<void>("delete_live_backup", { app, id }),
};
