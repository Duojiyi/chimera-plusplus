import { invoke } from "@tauri-apps/api/core";
import { providersApi } from "./providers";
import type { SubscriptionQuota } from "@/types/subscription";

export interface OfficialAccountDto {
  key: string;
  accountId: string;
  displayName: string;
  email?: string | null;
  capturedAt: string;
  isCurrent: boolean;
  needsRelogin: boolean;
  providerId?: string | null;
}

export interface StartedLoginDto {
  flowId: string;
  verificationUrl: string;
  userCode: string;
  expiresAt: string;
  expiresInSeconds?: number;
}

export interface PollLoginDto {
  status: "pending" | "completed" | "expired" | "failed";
  key?: string | null;
  error?: string | null;
}

export const officialAccountsApi = {
  list: async (): Promise<OfficialAccountDto[]> => {
    return invoke<OfficialAccountDto[]>("list_official_accounts");
  },

  getQuota: async (key: string): Promise<SubscriptionQuota> => {
    return invoke<SubscriptionQuota>("get_official_account_quota", { key });
  },

  saveCurrentLogin: async (name?: string): Promise<string> => {
    return invoke<string>("save_current_official_login", {
      name: name || null,
    });
  },

  startDeviceLogin: async (): Promise<StartedLoginDto> => {
    return invoke<StartedLoginDto>("start_official_device_login");
  },

  pollDeviceLogin: async (flowId: string): Promise<PollLoginDto> => {
    return invoke<PollLoginDto>("poll_official_device_login", { flowId });
  },

  cancelDeviceLogin: async (flowId: string): Promise<void> => {
    return invoke<void>("cancel_official_device_login", { flowId });
  },

  switchAccount: async (keyOrProviderId: string): Promise<void> => {
    const accounts = await officialAccountsApi.list();
    const account =
      accounts.find((item) => item.key === keyOrProviderId) ??
      accounts.find((item) => item.providerId === keyOrProviderId);
    if (!account?.providerId)
      throw new Error("账号尚未关联线路，请先保存登录状态");
    if (account.needsRelogin) throw new Error("账号登录已过期，请重新登录");
    await providersApi.switch(account.providerId, "codex");
  },

  removeAccount: async (key: string): Promise<void> => {
    return invoke<void>("remove_official_account", { key });
  },

  getNotes: async (table: string): Promise<Record<string, string>> => {
    return invoke<Record<string, string>>("get_notes", { table });
  },

  setNotes: async (
    table: string,
    id: string,
    notes?: string,
  ): Promise<void> => {
    return invoke<void>("set_notes", { table, id, notes: notes || null });
  },

  getCodexMcpSectionPreview: async (
    id: string,
    spec: unknown,
    mask?: string,
  ): Promise<[string, string]> => {
    return invoke<[string, string]>("get_codex_mcp_section_preview", {
      id,
      spec,
      mask: mask || null,
    });
  },
};
