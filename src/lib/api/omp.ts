import { invoke } from "@tauri-apps/api/core";
import type { PiDocument } from "./pi";

export const ompApi = {
  read: () => invoke<PiDocument>("get_omp_models"),
  /** `allowLossyRewrite` confirms dropping comments/anchors (a backup is kept). */
  save: (
    value: Record<string, unknown>,
    document: PiDocument,
    allowLossyRewrite = false,
  ) =>
    invoke<PiDocument>("save_omp_models", {
      value,
      expectedRevision: document.revision,
      expectedPath: document.path,
      ...(allowLossyRewrite ? { allowLossyRewrite: true } : {}),
    }),
};

// Provider API names in the supported OMP 18.8.3 native schema.
export const ompApis = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-gemini-cli",
  "google-vertex",
  "openrouter-decisions",
  "typesafe",
];
