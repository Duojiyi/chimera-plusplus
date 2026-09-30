import { invoke } from "@tauri-apps/api/core";
import type { AppId } from "./types";

/** Mirrors `tool_registry::ToolInfo` (backend is the source of truth). */
export type ToolMode = "switch" | "additive";

export type DeeplinkPolicy = "importConfirm" | "importOnly" | "reject";

export interface ToolInfo {
  id: AppId;
  mode: ToolMode;
  /** Default locations; overrides are resolved by the backend. */
  liveFiles: string[];
  tray: boolean;
  deeplink: DeeplinkPolicy;
  proxy: boolean;
}

export const toolRegistryApi = {
  /** All 10 tools in plan order. */
  async list(): Promise<ToolInfo[]> {
    return await invoke("get_tool_registry");
  },
};
