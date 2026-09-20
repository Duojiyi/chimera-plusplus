import { invoke } from "@tauri-apps/api/core";
import type { SessionMessage, SessionMeta } from "@/types";

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

export const sessionsApi = {
  async list(): Promise<SessionMeta[]> {
    return await invoke("list_sessions");
  },

  async getMessages(
    providerId: string,
    sourcePath: string,
  ): Promise<SessionMessage[]> {
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
