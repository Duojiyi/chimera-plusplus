import { invoke } from "@tauri-apps/api/core";

/** What a saved login is made of. */
/** `desktop_only`: only Claude Desktop's sign-in, saved from this computer. */
export type ClaudeAccountKind =
  "oauth" | "setup_token" | "api_key" | "desktop_only";

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
  kind: ClaudeAccountKind;
  /** Held out of use: not switched to, not opened in parallel, no quota. */
  disabled: boolean;
  /** A terminal is open on this login (a parallel session). */
  sessionRunning: boolean;
  /** The user's note. */
  note?: string | null;
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
  /** A terminal can be opened on a saved login (parallel sessions). */
  sessionsSupported: boolean;
  live: ClaudeCodeLive;
  /** The live login files could not be read. */
  liveError?: string | null;
  accounts: ClaudeCodeAccount[];
}

export type ClaudeBindingState = "ready" | "missing" | "disabled";

/** A folder bound to a saved login. */
export interface ClaudeBinding {
  path: string;
  accountId: string;
  accountName?: string | null;
  accountEmail?: string | null;
  state: ClaudeBindingState;
  /** The folder is gone. */
  pathMissing: boolean;
}

export interface ClaudeSessionLaunch {
  accountId?: string | null;
  accountName?: string | null;
  dir?: string | null;
  /** The folder's binding chose the account. */
  viaBinding: boolean;
  /** The account is Claude Code's current login: a plain terminal opened. */
  usesDefaultLogin: boolean;
  /** Things that were not shared into the session folder. */
  warnings?: string[];
}

export interface ClaudeSessionCommands {
  dir: string;
  cmd: string;
  powershell: string;
}

export interface ClaudeUsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** The part of `cacheWrite` kept for an hour. */
  cacheWrite1h?: number;
}

export interface ClaudeUsageBucket {
  tokens: ClaudeUsageTokens;
  messages: number;
  costUsd: number;
  /** Some tokens are from a model with no known price. */
  costPartial: boolean;
}

export interface ClaudeUsageDay extends ClaudeUsageBucket {
  /** `YYYY-MM-DD`, local time. */
  day: string;
}

export interface ClaudeUsageNamed extends ClaudeUsageBucket {
  name: string;
  /** The project folder, or the saved login's id. */
  detail?: string | null;
  lastDay?: string | null;
}

export interface ClaudeUsageOverview {
  rangeDays?: number | null;
  filesScanned: number;
  /** Some files were left out because there were too many. */
  truncated: boolean;
  /** Links, and files that could not be read or are too large. */
  filesSkipped?: number;
  totals: ClaudeUsageBucket;
  days: ClaudeUsageDay[];
  projects: ClaudeUsageNamed[];
  models: ClaudeUsageNamed[];
  sources: ClaudeUsageNamed[];
}

export interface ClaudeDesktopSnapshot {
  accountId: string;
  capturedAt: string;
  /** Desktop is signed in as this account now. */
  isCurrent: boolean;
}

export interface ClaudeDesktopSwapStatus {
  supported: boolean;
  /** Claude Desktop has its data open. */
  running: boolean;
  signedIn: boolean;
  accountUuid?: string | null;
  /** The saved login Desktop is signed in as, when it is one. */
  currentAccountId?: string | null;
  snapshots: ClaudeDesktopSnapshot[];
}

export interface ClaudeDesktopSwapOutcome {
  status: "done" | "desktop_running";
  /** It was running and was closed for this. */
  wasRunning: boolean;
  /** ...and has been opened again. */
  restarted: boolean;
  savedOutgoingFor?: string | null;
  stashedOutgoing: boolean;
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
  /** Things worth knowing about what was imported. */
  notes?: string[];
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

  /** Sets the note of a saved login; empty text clears it. */
  setNote: (id: string, note: string): Promise<void> =>
    invoke<void>("set_claude_account_note", { id, note }),

  /** Imports logins from pasted JSON (a claude-swap export or .credentials.json). */
  importLoginsText: (text: string): Promise<ClaudeLoginImportReport> =>
    invoke<ClaudeLoginImportReport>("import_claude_logins_text", { text }),

  renameCode: (id: string, name: string): Promise<void> =>
    invoke<void>("rename_claude_code_account", { id, name }),

  deleteCode: (id: string): Promise<void> =>
    invoke<void>("delete_claude_code_account", { id }),

  /** `force` is a manual refresh; otherwise a reading under 5 minutes old is reused. */
  codeQuota: (id: string, force = false): Promise<ClaudeQuota> =>
    invoke<ClaudeQuota>("get_claude_code_account_quota", { id, force }),

  /** Saves a pasted setup-token or Console API key as an account. */
  addSecret: (secret: string, name?: string): Promise<ClaudeCodeAccount> =>
    invoke<ClaudeCodeAccount>("add_claude_secret_account", {
      name: name?.trim() || null,
      secret,
    }),

  setDisabled: (id: string, disabled: boolean): Promise<void> =>
    invoke<void>("set_claude_account_disabled", { id, disabled }),

  /** Puts the listed logins first, in this order. */
  reorder: (ids: string[]): Promise<void> =>
    invoke<void>("reorder_claude_accounts", { ids }),

  /** A terminal on a login's session folder, a folder, or both. */
  openSession: (
    options: { id?: string; dir?: string } = {},
  ): Promise<ClaudeSessionLaunch> =>
    invoke<ClaudeSessionLaunch>("open_claude_session", {
      id: options.id ?? null,
      dir: options.dir ?? null,
    }),

  sessionCommands: (id: string): Promise<ClaudeSessionCommands> =>
    invoke<ClaudeSessionCommands>("get_claude_session_commands", { id }),

  listBindings: (): Promise<ClaudeBinding[]> =>
    invoke<ClaudeBinding[]>("list_claude_bindings"),

  setBinding: (path: string, accountId: string): Promise<ClaudeBinding> =>
    invoke<ClaudeBinding>("set_claude_binding", { path, accountId }),

  removeBinding: (path: string): Promise<void> =>
    invoke<void>("remove_claude_binding", { path }),

  /** A folder picked in the system dialog; `null` when it was cancelled. */
  pickFolder: (): Promise<string | null> =>
    invoke<string | null>("pick_claude_folder"),

  /** `rangeDays` null/undefined means everything. */
  usageOverview: (rangeDays?: number | null): Promise<ClaudeUsageOverview> =>
    invoke<ClaudeUsageOverview>("get_claude_usage_overview", {
      rangeDays: rangeDays ?? null,
    }),

  desktopSwapStatus: (): Promise<ClaudeDesktopSwapStatus> =>
    invoke<ClaudeDesktopSwapStatus>("get_claude_desktop_swap_status"),

  /** Saves the default Desktop's sign-in for a saved login. */
  /**
   * Saves the account the default Desktop is signed in as (when no saved
   * login has it) as a Desktop-only login; `email` is only its name.
   */
  saveDesktopOnly: (email?: string | null): Promise<ClaudeCodeAccount> =>
    invoke<ClaudeCodeAccount>("save_claude_desktop_only_login", {
      email: email ?? null,
    }),

  captureDesktopLogin: (
    id: string,
    closeDesktop = false,
  ): Promise<ClaudeDesktopSwapOutcome> =>
    invoke<ClaudeDesktopSwapOutcome>("capture_claude_desktop_login", {
      id,
      closeDesktop,
    }),

  /** Makes the default Desktop sign in as a saved login. */
  switchDesktop: (
    id: string,
    closeDesktop = false,
  ): Promise<ClaudeDesktopSwapOutcome> =>
    invoke<ClaudeDesktopSwapOutcome>("switch_claude_desktop_account", {
      id,
      closeDesktop,
    }),

  /**
   * Takes the default Desktop back to its sign-in page (keeping the sign-in
   * in use, signing nobody out), so a saved login can be signed in there.
   */
  prepareDesktopLogin: (
    id: string,
    closeDesktop = false,
  ): Promise<ClaudeDesktopSwapOutcome> =>
    invoke<ClaudeDesktopSwapOutcome>("prepare_claude_desktop_login", {
      id,
      closeDesktop,
    }),

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
