import { invoke } from "@tauri-apps/api/core";
export type PiRuntime = "pi" | "omp";
export type PluginAction =
  | "version"
  | "installRuntime"
  | "list"
  | "install"
  | "remove"
  | "update"
  | "enable"
  | "disable"
  | "discover"
  | "markets"
  | "addMarket"
  | "removeMarket"
  | "refreshMarkets";
export const piPluginsApi = {
  run: (runtime: PiRuntime, action: PluginAction, target = "") =>
    invoke<string>("run_pi_plugin_action", { runtime, action, target }),
};
export function validPluginTarget(value: string): boolean {
  return (
    value.length <= 214 &&
    value === value.trim() &&
    /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9][a-zA-Z0-9._+-]*)?$/.test(
      value,
    )
  );
}
export interface OmpPlugin {
  id: string;
  version: string;
  enabled: boolean | null;
}
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
// Never guess IDs from decorated terminal discovery output.
export function parseOmpPlugins(output: string): OmpPlugin[] {
  const value = object(JSON.parse(output));
  if (!value || !Array.isArray(value.npm) || !Array.isArray(value.marketplace))
    throw new Error("无法识别 OMP 插件列表，请检查版本。");
  const result: OmpPlugin[] = [];
  for (const [items, marketplace] of [
    [value.npm, false],
    [value.marketplace, true],
  ] as const) {
    for (const item of items) {
      const row = object(item);
      const id = marketplace ? row?.id : row?.name;
      if (!row || typeof id !== "string")
        throw new Error("OMP 插件条目缺少名称。");
      const entry = marketplace
        ? Array.isArray(row.entries)
          ? object(row.entries[0])
          : null
        : row;
      result.push({
        id,
        version: typeof entry?.version === "string" ? entry.version : "未知",
        enabled:
          typeof row.enabled === "boolean"
            ? row.enabled
            : typeof entry?.enabled === "boolean"
              ? entry.enabled
              : marketplace && entry && entry.enabled === undefined
                ? true
                : null,
      });
    }
  }
  return result;
}
