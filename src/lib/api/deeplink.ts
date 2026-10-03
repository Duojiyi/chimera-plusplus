import { invoke } from "@tauri-apps/api/core";

export type ResourceType = "provider" | "prompt" | "mcp" | "skill";

export interface DeepLinkImportRequest {
  version: string;
  resource: ResourceType;

  // Common fields
  app?: "claude" | "codex" | "gemini";
  name?: string;
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
}

/** Backend verdict for one env key (see `deeplink/env_allowlist.rs`). */
export type EnvKeyStatus = "allowed" | "needsConfirmation" | "denied";

export interface DeepLinkImportPreview {
  /** Absolute paths of the live files this resource is written to once active. */
  targetPaths: string[];
  /** Whether confirming writes `targetPaths` right away. */
  writesLive: boolean;
  /** Full content carried by the link, as it will be stored. */
  content: string;
  env: Array<{ key: string; status: EnvKeyStatus }>;
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
