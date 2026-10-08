import type { VisibleApps } from "@/types";
import {
  additionalToolNames,
  nativeToolNames,
} from "@/utils/toolProviderConfig";

export const toolDisplayNames: Record<keyof VisibleApps, string> = {
  codex: "Codex",
  ...nativeToolNames,
  ...additionalToolNames,
  omp: "oh-my-pi",
};

/**
 * Two-letter marks drawn in tool badges. The sidebar tool list (ChimeraApp)
 * and the tool page headers (ToolView) draw the same letters, so a tool is
 * recognisable by its badge everywhere.
 */
export const toolBadgeMarks: Record<keyof VisibleApps, string> = {
  codex: "Cx",
  claude: "CC",
  "claude-desktop": "CD",
  gemini: "Gm",
  grokbuild: "Gk",
  opencode: "OC",

  pi: "Pi",
  omp: "OMP",
};
