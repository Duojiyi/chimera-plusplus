import { invoke } from "@tauri-apps/api/core";
import type { SessionMessage, SessionMeta } from "@/types";

/** A `list_sessions` row. `archived` (Codex only) is omitted when false. */
export type SessionListEntry = SessionMeta & { archived?: boolean };

/**
 * A `get_session_messages` entry. `truncated` marks an entry the reader
 * shortened, or a `notice` entry standing in for content too large to load;
 * it is omitted when false.
 */
export type SessionTranscriptEntry = SessionMessage & { truncated?: boolean };

export interface DeleteSessionOptions {
  providerId: string;
  sessionId: string;
  sourcePath: string;
}

export interface DeleteSessionResult extends DeleteSessionOptions {
  success: boolean;
  /** Content is gone even when index cleanup needs another attempt. */
  sourceDeleted: boolean;
  cleanupPending: boolean;
  error?: string;
  /**
   * Records left behind on purpose because no retry can clean them (a newer
   * Codex store, an oversized history). The delete still succeeded.
   */
  cleanupNote?: string;
}

export interface CodexHistoryReclaimResult {
  reclaimedJsonlFiles: number;
  reclaimedStateRows: number;
  /** Active files deferred until their writers stop; retry the same operation. */
  deferredJsonlFiles: number;
  /** 本次归拢涉及的来源桶 id。 */
  sourceProviderIds: string[];
  /** 被跳过的原因，用于区分「无需恢复」与「恢复了 0 项」。 */
  skippedReason?: string;
}

/** A backup taken before a session delete, as `list_session_delete_backups` returns it. */
export interface SessionDeleteBackup {
  /** `<tool>/<generation>`; passed back to restore. */
  id: string;
  providerId: string;
  /** RFC 3339 time of the delete. */
  createdAt?: string;
  sessionIds: string[];
  title?: string;
  fileCount: number;
  totalBytes: number;
  /** Files whose original location is free, so a restore would write them. */
  restorableFiles: number;
}

export interface SessionDeleteRestoreResult {
  providerId: string;
  restoredFiles: number;
  /** Files left alone because something already exists at their path. */
  skippedExisting: number;
}

export interface SessionDeleteBackupsCleared {
  removedBackups: number;
  freedBytes: number;
}

export const sessionsApi = {
  /** The native save dialog owns the destination; null means the user cancelled. */
  async exportFile(options: {
    fileName: string;
    format: "markdown" | "json";
    content: string;
  }): Promise<string | null> {
    return await invoke("export_session_file", options);
  },

  async list(): Promise<SessionListEntry[]> {
    return await invoke("list_sessions");
  },

  async getMessages(
    providerId: string,
    sourcePath: string,
  ): Promise<SessionTranscriptEntry[]> {
    return await invoke("get_session_messages", { providerId, sourcePath });
  },

  async delete(options: DeleteSessionOptions): Promise<boolean> {
    const { providerId, sessionId, sourcePath } = options;
    return await invoke("delete_session", {
      providerId,
      sessionId,
      sourcePath,
    });
  },

  async deleteMany(
    items: DeleteSessionOptions[],
  ): Promise<DeleteSessionResult[]> {
    return await invoke("delete_sessions", { items });
  },

  /**
   * 把所有第三方桶的 Codex 历史会话归拢到当前共享 custom 桶。
   *
   * 切换中转供应商后会话列表看起来「丢失」时使用：会话文件仍在
   * `~/.codex/sessions`，只是记录的 model_provider 是旧桶 id。改写前会自动备份。
   */
  async reclaimCodexHistory(): Promise<CodexHistoryReclaimResult> {
    return await invoke("reclaim_codex_history_sessions");
  },

  async listDeleteBackups(): Promise<SessionDeleteBackup[]> {
    return await invoke("list_session_delete_backups");
  },

  /** Never overwrites: files whose path is taken again are skipped. */
  async restoreDeleteBackup(
    backupId: string,
  ): Promise<SessionDeleteRestoreResult> {
    return await invoke("restore_session_delete_backup", { backupId });
  },

  async clearDeleteBackups(): Promise<SessionDeleteBackupsCleared> {
    return await invoke("clear_session_delete_backups");
  },

  async launchTerminal(options: {
    command: string;
    cwd?: string | null;
    customConfig?: string | null;
  }): Promise<boolean> {
    const { command, cwd, customConfig } = options;
    return await invoke("launch_session_terminal", {
      command,
      cwd,
      customConfig,
    });
  },
};
