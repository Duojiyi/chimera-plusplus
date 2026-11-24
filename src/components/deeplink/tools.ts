import registry from "@/shared/tool-registry.json";
import { toolDisplayNames } from "@/components/settings/toolBadges";

/** Display names of the tools a deep link can target, as in the sidebar. */
const TOOL_NAMES: Record<string, string> = {
  ...toolDisplayNames,
  claude_desktop: "Claude Desktop",
  grok: "Grok Build",
};

export function toolName(app?: string | null): string {
  const id = app?.trim() ?? "";
  return TOOL_NAMES[id] ?? (id || "该工具");
}

/** Tools that enable several lines at once instead of switching one. */
const ADDITIVE_TOOLS = new Set(
  registry.filter((tool) => tool.mode === "additive").map((tool) => tool.id),
);

export function isAdditiveTool(app?: string | null): boolean {
  return ADDITIVE_TOOLS.has(app?.trim() ?? "");
}
