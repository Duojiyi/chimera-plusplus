import type { VisibleApps } from "@/types";

export const productToolViews = {
  "tool-claude": "claude",
  "tool-claude-desktop": "claude-desktop",
  "tool-gemini": "gemini",
  "tool-grokbuild": "grokbuild",
  "tool-opencode": "opencode",

  "tool-pi": "pi",
  "tool-omp": "omp",
} as const satisfies Record<string, keyof VisibleApps>;

export function isProductToolVisible(
  view: string,
  visibleApps?: Partial<VisibleApps>,
): boolean {
  const appId = productToolViews[view as keyof typeof productToolViews];
  return !appId || visibleApps?.[appId] === true;
}

export type ProductCapability = {
  id: string;
  available: boolean;
  enabledByDefault: boolean;
};

export function hasEnabledCapability(
  capabilities: ProductCapability[],
  id: string,
): boolean {
  return capabilities.some(
    (item) =>
      item.id === id &&
      item.available === true &&
      item.enabledByDefault === true,
  );
}

// Established Codex routes remain reachable during policy loading/failure.
// Their mutation controls retain their existing backend guards.
const coreViews = new Set([
  "providers",
  "sessions",
  "usage",
  "runtime",
  "appearance",
  "settings",
]);
const gatedViews: Record<string, string[]> = {
  "tool-settings": ["multi_tool"],
  "official-accounts": ["official_accounts"],
  prompts: ["prompts"],
  "skills-mcp": ["skills", "mcp"],
  health: ["config_health"],
  "tool-claude": ["multi_tool"],
  "tool-gemini": ["multi_tool"],
  "tool-opencode": ["multi_tool"],
  "tool-pi": ["multi_tool"],
  "tool-omp": ["multi_tool"],
  "tool-claude-desktop": ["multi_tool"],
  "tool-grokbuild": ["multi_tool"],
};

export function canOpenProductView(
  view: string,
  capabilities: ProductCapability[],
): boolean {
  return (
    coreViews.has(view) ||
    (Object.hasOwn(gatedViews, view) &&
      gatedViews[view].every((id) => hasEnabledCapability(capabilities, id)))
  );
}
