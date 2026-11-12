import { invoke } from "@tauri-apps/api/core";
import { providersApi } from "./providers";
import type { SubscriptionQuota } from "@/types/subscription";

/** How Codex's live login relates to the saved accounts (same on every row). */
export type OfficialLiveState =
  "matched" | "unsaved" | "mismatch" | "third_party" | "unknown";

export interface OfficialAccountGroup {
  id: string;
  name: string;
  color?: string | null;
  sortIndex: number;
  accountCount: number;
}

export interface OfficialAccountDto {
  key: string;
  accountId: string;
  displayName: string;
  email?: string | null;
  /** Plan from the login's claims, e.g. "plus", "pro", "team". */
  planType?: string | null;
  /** Name of the line that uses this account. */
  lineName?: string | null;
  capturedAt: string;
  isCurrent: boolean;
  /** The account's line is the line selected for Codex. */
  isSelected?: boolean;
  needsRelogin: boolean;
  /** The stored login cannot be read here; it can only be signed in again or removed. */
  unreadable?: boolean;
  /** The access token has expired; Codex renews it when the account is used. */
  accessExpired?: boolean;
  providerId?: string | null;
  liveState?: OfficialLiveState;
  /** The user's tags, normalized by the backend. */
  tags?: string[];
  groupId?: string | null;
  groupName?: string | null;
  note?: string | null;
  /** Held out of use by the user; the credentials stay. */
  disabled?: boolean;
  /** Last time Codex was seen using this account (ms since epoch). */
  lastUsedAt?: number | null;
}

export interface OfficialAccountRemovalDto {
  removed: string[];
  failed: { key: string; error: string }[];
}

/** A quota answer; `accessExpired` means nothing was queried. */
export type OfficialQuota = SubscriptionQuota & { accessExpired?: boolean };

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

  /**
   * `refresh` is the user asking for a new reading: without it a reading
   * under 5 minutes old is answered from the stored one.
   */
  getQuota: async (key: string, refresh?: boolean): Promise<OfficialQuota> => {
    return invoke<OfficialQuota>(
      "get_official_account_quota",
      refresh ? { key, refresh: true } : { key },
    );
  },

  saveCurrentLogin: async (name?: string): Promise<string> => {
    return invoke<string>("save_current_official_login", {
      name: name || null,
    });
  },

  startDeviceLogin: async (): Promise<StartedLoginDto> => {
    return invoke<StartedLoginDto>("start_official_device_login");
  },

  startBrowserLogin: async (): Promise<StartedLoginDto> => {
    return invoke<StartedLoginDto>("start_official_browser_login");
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
    if (account.disabled) throw new Error("这个账号已停用，请先启用它");
    await providersApi.switch(account.providerId, "codex");
  },

  removeAccount: async (key: string): Promise<void> => {
    return invoke<void>("remove_official_account", { key });
  },

  /** Removes several accounts one at a time; never all-or-nothing. */
  removeAccounts: async (
    keys: string[],
  ): Promise<OfficialAccountRemovalDto> => {
    return invoke<OfficialAccountRemovalDto>("remove_official_accounts", {
      keys,
    });
  },

  /** Groups in the user's order, with how many accounts each holds. */
  listGroups: async (): Promise<OfficialAccountGroup[]> => {
    return invoke<OfficialAccountGroup[]>("list_official_account_groups");
  },

  createGroup: async (name: string): Promise<OfficialAccountGroup> => {
    return invoke<OfficialAccountGroup>("create_official_account_group", {
      name,
      color: null,
    });
  },

  /** Removes a group; its accounts become ungrouped. Returns how many. */
  deleteGroup: async (id: string): Promise<number> => {
    return invoke<number>("delete_official_account_group", { id });
  },

  /** `null` takes the account out of every group. */
  setGroup: async (key: string, group: string | null): Promise<void> => {
    return invoke<void>("set_official_account_group", { key, group });
  },

  setTags: async (key: string, tags: string[]): Promise<string[]> => {
    return invoke<string[]>("set_official_account_tags", { key, tags });
  },

  /** Blank clears the note. */
  setNote: async (key: string, note: string): Promise<void> => {
    return invoke<void>("set_official_account_note", {
      key,
      note: note.trim() || null,
    });
  },

  /** Holds the account out of use (or back in); the login stays saved. */
  setDisabled: async (key: string, disabled: boolean): Promise<void> => {
    return invoke<void>("set_official_account_disabled", {
      key,
      disabled,
      reason: null,
    });
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
