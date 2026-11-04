import { invoke } from "@tauri-apps/api/core";

/** A saved Claude Code login. Never carries a token. */
export interface ClaudeCodeAccount {
  id: string;
  name: string;
  email?: string | null;
  plan?: string | null;
  /** First 8 hex digits of SHA-256 of the saved access token. */
  fingerprint?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Claude Code uses this login now. */
  isCurrent: boolean;
  /** The refresh token was rejected: sign in again and save. */
  needsRelogin: boolean;
  /** Cannot be decrypted here; it can only be deleted. */
  unreadable: boolean;
}

export interface ClaudeCodeLive {
  signedIn: boolean;
  email?: string | null;
  plan?: string | null;
  fingerprint?: string | null;
  /** The saved account matching the live login. */
  savedId?: string | null;
}

export interface ClaudeCodeAccounts {
  supported: boolean;
  unsupportedReason?: string | null;
  /** Adding a login through the browser can be started from this app. */
  browserLoginSupported: boolean;
  live: ClaudeCodeLive;
  /** The live login files could not be read. */
  liveError?: string | null;
  accounts: ClaudeCodeAccount[];
}

/** Written by an export: the file holds live tokens. */
export interface ClaudeLoginExport {
  path: string;
  count: number;
  /** Saved logins left out because they lack an account block. */
  skipped: number;
}

export interface ClaudeLoginSkipped {
  email?: string | null;
  reason: string;
}

/** What an import did. Never carries a token. */
export interface ClaudeLoginImportReport {
  imported: ClaudeCodeAccount[];
  updated: ClaudeCodeAccount[];
  skipped: ClaudeLoginSkipped[];
}

export type ClaudeBrowserLoginPoll =
  | { state: "waiting" }
  | { state: "done"; account: ClaudeCodeAccount; created: boolean }
  | { state: "failed"; message: string }
  /** Finished, cancelled, or the app restarted. */
  | { state: "unknown" };

export type ClaudeSwitchStatus =
  "switched" | "already_current" | "claude_running";

export interface ClaudeSwitchOutcome {
  status: ClaudeSwitchStatus;
  /** The outgoing login was not saved yet and was saved under this id. */
  autoSavedId?: string | null;
}

export type ClaudeQuotaStatus =
  | "fresh"
  | "cached"
  | "needs_relogin"
  | "live_expired"
  | "unavailable"
  | "not_signed_in";

export interface ClaudeQuotaWindow {
  name: string;
  label: string;
  kind: "session" | "weekly" | "model";
  utilization: number;
  resetsAt?: string | null;
  /** The window has reset since the last reading. */
  reset: boolean;
  resetAt?: string | null;
}

export interface ClaudeExtraUsage {
  used: number;
  limit: number;
  utilization: number;
  currency: string;
  resetsAt?: string | null;
}

export interface ClaudeQuota {
  status: ClaudeQuotaStatus;
  windows: ClaudeQuotaWindow[];
  extraUsage?: ClaudeExtraUsage | null;
  fetchedAt?: number | null;
}

export interface ClaudeDesktopProfile {
  id: string;
  name: string;
  createdAt: string;
  initialized: boolean;
  signedIn: boolean;
}

/** A Claude Desktop account's plan and quota, read with its own sign-in. */
export interface ClaudeDesktopQuota {
  email?: string | null;
  plan?: string | null;
  quota: ClaudeQuota;
}

/** Id of Claude Desktop's own (default) data folder. */
export const DEFAULT_DESKTOP_ID = "default";

export const claudeAccountsApi = {
  listCode: (): Promise<ClaudeCodeAccounts> =>
    invoke<ClaudeCodeAccounts>("list_claude_code_accounts"),

  saveCurrentCode: (name?: string): Promise<ClaudeCodeAccount> =>
    invoke<ClaudeCodeAccount>("save_current_claude_code_login", {
      name: name?.trim() || null,
    }),

  switchCode: (
    id: string,
    allowRunning = false,
  ): Promise<ClaudeSwitchOutcome> =>
    invoke<ClaudeSwitchOutcome>("switch_claude_code_account", {
      id,
      allowRunning,
    }),

  renameCode: (id: string, name: string): Promise<void> =>
    invoke<void>("rename_claude_code_account", { id, name }),

  deleteCode: (id: string): Promise<void> =>
    invoke<void>("delete_claude_code_account", { id }),

  /** `force` is a manual refresh; otherwise a reading under 5 minutes old is reused. */
  codeQuota: (id: string, force = false): Promise<ClaudeQuota> =>
    invoke<ClaudeQuota>("get_claude_code_account_quota", { id, force }),

  /** Opens a save dialog; `null` when it was cancelled. `ids` limits the export. */
  exportLogins: (ids?: string[]): Promise<ClaudeLoginExport | null> =>
    invoke<ClaudeLoginExport | null>("export_claude_logins", {
      ids: ids ?? null,
    }),

  /** Opens a file dialog; `null` when it was cancelled. */
  importLogins: (): Promise<ClaudeLoginImportReport | null> =>
    invoke<ClaudeLoginImportReport | null>("import_claude_logins"),

  /** Starts the browser authorization and returns the flow id to poll. */
  beginBrowserLogin: (): Promise<string> =>
    invoke<string>("begin_claude_browser_login"),

  pollBrowserLogin: (id: string): Promise<ClaudeBrowserLoginPoll> =>
    invoke<ClaudeBrowserLoginPoll>("poll_claude_browser_login", { id }),

  cancelBrowserLogin: (id: string): Promise<void> =>
    invoke<void>("cancel_claude_browser_login", { id }),

  listDesktop: (): Promise<ClaudeDesktopProfile[]> =>
    invoke<ClaudeDesktopProfile[]>("list_claude_desktop_profiles"),

  /** `id` is a profile id or {@link DEFAULT_DESKTOP_ID}. Never refreshes the sign-in. */
  desktopQuota: (id: string, force = false): Promise<ClaudeDesktopQuota> =>
    invoke<ClaudeDesktopQuota>("get_claude_desktop_profile_quota", {
      id,
      force,
    }),

  createDesktop: (name: string): Promise<ClaudeDesktopProfile> =>
    invoke<ClaudeDesktopProfile>("create_claude_desktop_profile", { name }),

  renameDesktop: (id: string, name: string): Promise<ClaudeDesktopProfile> =>
    invoke<ClaudeDesktopProfile>("rename_claude_desktop_profile", {
      id,
      name,
    }),

  deleteDesktop: (id: string): Promise<void> =>
    invoke<void>("delete_claude_desktop_profile", { id }),

  launchDesktop: (id: string): Promise<void> =>
    invoke<void>("launch_claude_desktop_profile", { id }),
};
