import type { AppId } from "@/lib/api/types";
import {
  additionalToolNames,
  nativeToolNames,
} from "@/utils/toolProviderConfig";

export const toolDisplayNames: Record<AppId, string> = {
  codex: "Codex",
  ...nativeToolNames,
  ...additionalToolNames,
};

/**
 * Two-letter marks drawn in tool badges. The sidebar tool list (ChimeraApp)
 * and the tool page headers (ToolView) draw the same letters, so a tool is
 * recognisable by its badge everywhere.
 */
export const toolBadgeMarks: Record<AppId, string> = {
  codex: "Cx",
  claude: "CC",
  "claude-desktop": "CD",
  gemini: "Gm",
  grokbuild: "Gk",
  opencode: "OC",
  openclaw: "Cl",
  hermes: "He",
  pi: "Pi",
  mcode: "MM",
};
