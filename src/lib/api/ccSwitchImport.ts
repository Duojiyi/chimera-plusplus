import { invoke } from "@tauri-apps/api/core";

export type CcSwitchImportStatus =
  "new" | "identical" | "conflict" | "unsupported";

export interface CcSwitchImportRow {
  app: string;
  sourceId: string;
  name: string;
  status: CcSwitchImportStatus;
  reason: string;
  existingIds: string[];
  /** Only a conflict with one unprotected local line may replace it. */
  replaceable?: boolean;
  /** Keys the import removes from this row; names only. */
  sanitizedKeys?: string[];
}

export interface CcSwitchImportInventory {
  rows: CcSwitchImportRow[];
  writesLive: boolean;
  canCommit: boolean;
  previewId?: string | null;
}

export type CcSwitchImportAction = "import" | "skip" | "duplicate" | "replace";

export interface CcSwitchImportSelection {
  app: string;
  sourceId: string;
  action: CcSwitchImportAction;
}

export type CcSwitchImportOutcome =
  "imported" | "replaced" | "skipped" | "failed";

export interface CcSwitchImportRowResult {
  app: string;
  sourceId: string;
  name: string;
  outcome: CcSwitchImportOutcome;
  reason?: string;
}

export interface CcSwitchImportResult {
  rows: CcSwitchImportRowResult[];
  imported: number;
  replaced: number;
  skipped: number;
  failed: number;
  backupName: string;
  sanitizedKeys: string[];
}

export const ccSwitchImportApi = {
  preview: (path: string) =>
    invoke<CcSwitchImportInventory>("preview_cc_switch_file", { path }),
  commit: (previewId: string, selections: CcSwitchImportSelection[]) =>
    invoke<CcSwitchImportResult>("commit_cc_switch_import", {
      previewId,
      selections,
    }),
};
