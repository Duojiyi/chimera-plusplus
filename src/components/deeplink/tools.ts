/** Display names of the tools a deep link can target, as in the sidebar. */
const TOOL_NAMES: Record<string, string> = {
  claude: "Claude Code",
  "claude-desktop": "Claude Desktop",
  claude_desktop: "Claude Desktop",
  codex: "Codex",
  gemini: "Gemini CLI",
  grokbuild: "Grok Build",
  grok: "Grok Build",
  opencode: "OpenCode",
  pi: "Pi",
};

export function toolName(app?: string | null): string {
  const id = app?.trim() ?? "";
  return TOOL_NAMES[id] ?? (id || "该工具");
}

/** Tools that enable several lines at once instead of switching one. */
const ADDITIVE_TOOLS = new Set(["opencode", "pi"]);

export function isAdditiveTool(app?: string | null): boolean {
  return ADDITIVE_TOOLS.has(app?.trim() ?? "");
}
