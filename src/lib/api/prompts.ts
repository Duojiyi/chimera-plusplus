import { invoke } from "@tauri-apps/api/core";
import type { AppId } from "./types";

/** Prompt targets: every tool id plus oh-my-pi, which has no provider lines. */
export type PromptAppId = AppId | "omp";

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
  async getCategories(app: PromptAppId): Promise<PromptCategory[]> {
    return await invoke("get_prompt_categories", { app });
  },
  async createCategory(app: PromptAppId, name: string): Promise<string> {
    return await invoke("create_prompt_category", { app, name });
  },
  async renameCategory(
    app: PromptAppId,
    id: string,
    name: string,
  ): Promise<void> {
    return await invoke("rename_prompt_category", { app, id, name });
  },
  async deleteCategory(app: PromptAppId, id: string): Promise<void> {
    return await invoke("delete_prompt_category", { app, id });
  },
  async getPrompts(app: PromptAppId): Promise<Record<string, Prompt>> {
    return await invoke("get_prompts", { app });
  },

  async upsertPrompt(
    app: PromptAppId,
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
    app: PromptAppId,
    id: string,
    enabled: boolean,
  ): Promise<void> {
    return await invoke("set_prompt_enabled", { app, id, enabled });
  },

  async deletePrompt(app: PromptAppId, id: string): Promise<void> {
    return await invoke("delete_prompt", { app, id });
  },

  async enablePrompt(app: PromptAppId, id: string): Promise<void> {
    return await invoke("enable_prompt", { app, id });
  },

  async importFromFile(app: PromptAppId, filePath?: string): Promise<string> {
    return await invoke("import_prompt_from_file", {
      app,
      ...(filePath ? { filePath } : {}),
    });
  },

  async adoptForeignCodex(expectedContent: string): Promise<string> {
    return await invoke("adopt_foreign_codex_prompt", { expectedContent });
  },

  async getCurrentFileContent(app: PromptAppId): Promise<string | null> {
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
