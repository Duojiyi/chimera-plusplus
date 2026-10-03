import { invoke } from "@tauri-apps/api/core";

export type CcSwitchImportStatus =
  "new" | "identical" | "conflict" | "unsupported";
export interface CcSwitchImportInventory {
  rows: Array<{
    app: string;
    sourceId: string;
    name: string;
    status: CcSwitchImportStatus;
    reason: string;
    existingIds: string[];
  }>;
  writesLive: boolean;
  canCommit: boolean;
  previewId?: string | null;
}

export interface CcSwitchImportSelection {
  app: string;
  sourceId: string;
  replaceId?: string;
}

export interface CcSwitchImportReceipt {
  imported: number;
  backupId: string;
  writesLive: boolean;
}

export const ccSwitchImportApi = {
  preview: (path: string) =>
    invoke<CcSwitchImportInventory>("preview_cc_switch_file", { path }),
  commit: (previewId: string, selections: CcSwitchImportSelection[]) =>
    invoke<CcSwitchImportReceipt>("commit_cc_switch_import", {
      previewId,
      selections,
    }),
};
