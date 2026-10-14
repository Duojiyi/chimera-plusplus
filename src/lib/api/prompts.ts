import { invoke } from "@tauri-apps/api/core";
import type { AppId } from "./types";

export interface Prompt {
  id: string;
  name: string;
  content: string;
  description?: string;
  enabled: boolean;
  templateId?: string;
  categoryId?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface PromptCategory {
  id: string;
  name: string;
}

/** What Codex actually reads, compared with the enabled entries. */
export type CodexPromptState =
  | "in_sync"
  | "missing"
  | "edited"
  | "malformed"
  | "foreign"
  | "overridden"
  | "linked"
  | "unreadable";

export interface CodexPromptStatus {
  state: CodexPromptState;
  enabledCount: number;
  /** Bytes of the merged enabled entries; only present while they are in effect. */
  managedBytes?: number;
}

/** `rewrite` backs up AGENTS.md first; `keep_edits` never writes the file. */
export type CodexPromptResolution = "rewrite" | "keep_edits";

/**
 * Prompt commands prefix coded errors with their stable key, e.g.
 * "[prompt.managed.duplicate] …". Returns that key, or null for uncoded errors.
 */
export function promptErrorCode(reason: unknown): string | null {
  const text = reason instanceof Error ? reason.message : String(reason ?? "");
  return /^\[([a-z0-9_.]+)\]/.exec(text)?.[1] ?? null;
}

export const promptsApi = {
  async getCategories(app: AppId): Promise<PromptCategory[]> {
    return await invoke("get_prompt_categories", { app });
  },
  async createCategory(app: AppId, name: string): Promise<string> {
    return await invoke("create_prompt_category", { app, name });
  },
  async renameCategory(app: AppId, id: string, name: string): Promise<void> {
    return await invoke("rename_prompt_category", { app, id, name });
  },
  async deleteCategory(app: AppId, id: string): Promise<void> {
    return await invoke("delete_prompt_category", { app, id });
  },
  async getPrompts(app: AppId): Promise<Record<string, Prompt>> {
    return await invoke("get_prompts", { app });
  },

  async upsertPrompt(
    app: AppId,
    id: string,
    prompt: Prompt,
    expected?: Prompt,
  ): Promise<void> {
    return await invoke("upsert_prompt", {
      app,
      id,
      prompt,
      ...(expected ? { expected } : {}),
    });
  },

  async setPromptEnabled(
    app: AppId,
    id: string,
    enabled: boolean,
  ): Promise<void> {
    return await invoke("set_prompt_enabled", { app, id, enabled });
  },

  async deletePrompt(app: AppId, id: string): Promise<void> {
    return await invoke("delete_prompt", { app, id });
  },

  async enablePrompt(app: AppId, id: string): Promise<void> {
    return await invoke("enable_prompt", { app, id });
  },

  async importFromFile(app: AppId, filePath?: string): Promise<string> {
    return await invoke("import_prompt_from_file", {
      app,
      ...(filePath ? { filePath } : {}),
    });
  },

  async adoptForeignCodex(expectedContent: string): Promise<string> {
    return await invoke("adopt_foreign_codex_prompt", { expectedContent });
  },

  async getCurrentFileContent(app: AppId): Promise<string | null> {
    return await invoke("get_current_prompt_file_content", { app });
  },

  async getCodexStatus(): Promise<CodexPromptStatus> {
    return await invoke("get_codex_prompt_status");
  },

  async resolveCodexFile(
    action: CodexPromptResolution,
  ): Promise<string | null> {
    return await invoke("resolve_codex_prompt_file", { action });
  },
};
