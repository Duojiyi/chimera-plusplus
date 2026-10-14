import { invoke } from "@tauri-apps/api/core";

export type ResourceType = "provider" | "prompt" | "mcp" | "skill";

export interface DeepLinkImportRequest {
  version: string;
  resource: ResourceType;

  // Common fields
  app?:
    | "claude"
    | "claude-desktop"
    | "claude_desktop"
    | "codex"
    | "gemini"
    | "grokbuild"
    | "opencode"
    | "pi";
  name?: string;
  /**
   * What the link asks for. For providers the confirm dialog replaces it with
   * the user's own choice before importing.
   */
  enabled?: boolean;

  // Provider fields
  homepage?: string;
  endpoint?: string;
  apiKey?: string;
  icon?: string;
  model?: string;
  notes?: string;
  haikuModel?: string;
  sonnetModel?: string;
  opusModel?: string;

  // Prompt fields
  content?: string;
  description?: string;

  // MCP fields
  apps?: string; // "claude,codex,gemini"

  // Skill fields
  repo?: string;
  directory?: string;
  branch?: string;

  // Config file fields
  config?: string;
  configFormat?: string;
  configUrl?: string;

  // Usage script fields (v3.9+)
  /** What the link asks for; shown as a hint only, it never enables the query. */
  usageEnabled?: boolean;
  usageScript?: string;
  usageApiKey?: string;
  usageBaseUrl?: string;
  usageAccessToken?: string;
  usageUserId?: string;
  usageAutoInterval?: number;

  // Set by the confirm dialog: env keys outside the tool's allowlist that the
  // user confirmed one by one. Denied keys are dropped by the backend anyway.
  confirmedEnvKeys?: string[];
  /**
   * Set by the confirm dialog's "导入后启用用量查询" switch. The backend
   * enables a link's usage script only when this is true.
   */
  confirmedUsageEnabled?: boolean;
}

/** Backend verdict for one env key (see `deeplink/env_allowlist.rs`). */
export type EnvKeyStatus = "allowed" | "needsConfirmation" | "denied";

/** A link's usage query script (see `deeplink/preview.rs`). */
export interface UsageScriptPreview {
  /** The decoded script, exactly as it will be stored. */
  code: string;
  /** Hosts the script may contact (same host and port as its base URL). */
  hosts: string[];
  /** The link asked for the query to be enabled; only the dialog decides. */
  linkRequestsEnabled: boolean;
  /** Automatic query interval in minutes, when the link sets one. */
  autoIntervalMinutes?: number | null;
}

export interface DeepLinkImportPreview {
  /** Absolute paths of the live files this resource is written to once active. */
  targetPaths: string[];
  /** Whether the link itself asks to write `targetPaths` on confirm. */
  writesLive: boolean;
  /** Whether confirming may switch to this provider (offered as a switch). */
  mayActivate?: boolean;
  /** Full content carried by the link, as it will be stored. */
  content: string;
  env: Array<{ key: string; status: EnvKeyStatus }>;
  /** The usage query script the link carries, if any. */
  usage?: UsageScriptPreview | null;
  /** Names of link parameters and config entries that are not imported. */
  ignored?: string[];
}

export interface McpImportResult {
  importedCount: number;
  importedIds: string[];
  failed: Array<{
    id: string;
    error: string;
  }>;
}

export type ImportResult =
  | { type: "provider"; id: string }
  | { type: "prompt"; id: string }
  | {
      type: "mcp";
      importedCount: number;
      importedIds: string[];
      failed: Array<{ id: string; error: string }>;
    }
  | { type: "skill"; key: string };

export const deeplinkApi = {
  /** Queue a pasted link for the existing confirmation UI; never import here. */
  submitImport: async (url: string): Promise<void> => {
    return invoke("submit_deeplink_import", { url });
  },
  /**
   * Parse a deep link URL
   * @param url The ccswitch:// URL to parse
   * @returns Parsed deep link request
   */
  parseDeeplink: async (url: string): Promise<DeepLinkImportRequest> => {
    return invoke("parse_deeplink", { url });
  },

  /**
   * Merge configuration from Base64/URL into a deep link request
   * This is used to show the complete configuration in the confirmation dialog
   * @param request The deep link import request
   * @returns Merged deep link request with config fields populated
   */
  mergeDeeplinkConfig: async (
    request: DeepLinkImportRequest,
  ): Promise<DeepLinkImportRequest> => {
    return invoke("merge_deeplink_config", { request });
  },

  /**
   * What confirming this request stores and writes (full content, absolute
   * target paths, env-key verdicts). Merges inline config on the backend.
   */
  previewDeeplinkImport: async (
    request: DeepLinkImportRequest,
  ): Promise<DeepLinkImportPreview> => {
    return invoke("preview_deeplink_import", { request });
  },

  /**
   * Import a resource from a deep link request (unified handler)
   * @param request The deep link import request
   * @returns Import result based on resource type
   */
  importFromDeeplink: async (
    request: DeepLinkImportRequest,
  ): Promise<ImportResult> => {
    return invoke("import_from_deeplink_unified", { request });
  },
};
