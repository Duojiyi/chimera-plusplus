/**
 * Codex 配置模板
 * 用于新建自定义供应商时的默认配置
 */
import { invoke } from "@tauri-apps/api/core";

export interface CodexTemplate {
  auth: Record<string, any>;
  config: string;
}

export interface ChimeraHubTemplate extends CodexTemplate {
  name: string;
  websiteUrl: string;
  /** OpenAI-compatible `/v1` endpoint shared by every tool's preset. */
  baseUrl: string;
  model: string;
}

/**
 * 获取 Codex 自定义模板
 * @returns Codex 模板配置
 */
export function getCodexCustomTemplate(): CodexTemplate {
  // `gpt-5.6-sol` is the built-in Codex slug; a bare `gpt-5.6` is not in any
  // catalog and made the first request of a fresh custom line fail.
  const config = `model_provider = "custom"
model = "gpt-5.6-sol"
model_reasoning_effort = "high"

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = false`;

  return {
    auth: { OPENAI_API_KEY: "" },
    config,
  };
}

let chimeraHubTemplate: ChimeraHubTemplate | null = null;

/**
 * Loads the built-in ChimeraHub template from the backend, which owns it
 * (`builtin_templates.rs`). Called once before the app renders.
 */
export async function loadChimeraHubTemplate(): Promise<ChimeraHubTemplate> {
  chimeraHubTemplate = await invoke<ChimeraHubTemplate>(
    "get_chimerahub_template",
  );
  return chimeraHubTemplate;
}

/**
 * The only customer-facing built-in provider template. Its endpoint remains
 * editable in the provider editor for users with a dedicated relay address.
 * Until the backend template is loaded (browser preview, or a failed load)
 * this is an empty, still editable draft rather than a second copy.
 */
export function getChimeraHubTemplate(): ChimeraHubTemplate {
  const template = chimeraHubTemplate;
  return {
    name: template?.name ?? "",
    websiteUrl: template?.websiteUrl ?? "",
    baseUrl: template?.baseUrl ?? "",
    model: template?.model ?? "",
    auth: { ...(template?.auth ?? { OPENAI_API_KEY: "" }) },
    config: template?.config ?? "",
  };
}

/**
 * Builds a preset whose fields come from the ChimeraHub template. Preset lists
 * are module constants evaluated before the template loads, so every field is
 * resolved when it is read.
 */
export function chimeraHubPreset<T extends object>(
  build: (template: ChimeraHubTemplate) => T,
): T {
  // Rebuilt only when the loaded template changes, so field identities stay
  // stable between reads like a plain preset object.
  let source: ChimeraHubTemplate | null | undefined;
  let current: T | undefined;
  const resolve = (): T => {
    if (current === undefined || source !== chimeraHubTemplate) {
      source = chimeraHubTemplate;
      current = build(getChimeraHubTemplate());
    }
    return current;
  };
  const preset = {} as T;
  for (const key of Object.keys(resolve())) {
    Object.defineProperty(preset, key, {
      enumerable: true,
      get: () => resolve()[key as keyof T],
    });
  }
  return preset;
}
