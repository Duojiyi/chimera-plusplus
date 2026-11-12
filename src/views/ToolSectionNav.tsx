import {
  Cpu,
  Download,
  GitBranch,
  Package,
  Settings2,
  type LucideIcon,
} from "lucide-react";

export type ToolSection = { id: string; label: string; icon: LucideIcon };

const lines: ToolSection = { id: "lines", label: "线路", icon: GitBranch };
const resources: ToolSection = {
  id: "resources",
  label: "Skills 与 MCP",
  icon: Cpu,
};
const install: ToolSection = {
  id: "install",
  label: "安装与更新",
  icon: Download,
};
const routes: ToolSection = {
  id: "routes",
  label: "模型线路",
  icon: GitBranch,
};
const plugins: ToolSection = {
  id: "plugins",
  label: "插件市场",
  icon: Package,
};

/**
 * The sections of each tool page, by capability (design system §4.1). The
 * ids are stable: the shell can drive a page through `section` /
 * `onSectionChange` and keep these in its sidebar.
 */
export const TOOL_SECTIONS: Record<string, readonly ToolSection[]> = {
  // Official sign-ins (TOOLS_WITH_ACCOUNTS) are a sub-item of the lines
  // section: an official account is one more way to run the tool.
  "claude-code": [lines, resources, install],
  // Claude Desktop has no managed Skills or MCP (its third-party mode cannot
  // load them), and its installation status sits with its configuration
  // status on the lines section.
  "claude-desktop": [lines],
  "gemini-cli": [lines, resources, install],
  grokbuild: [lines, resources, install],
  opencode: [lines, resources, install],
  pi: [
    routes,
    { id: "settings", label: "默认模型与 MCP", icon: Settings2 },
    plugins,
    install,
  ],
  omp: [routes, plugins, install],
};

/** Tools whose official sign-ins are part of their lines: 官方账号 is shown
 * as a sub-item under 线路 (sidebar) and is the `accounts` section. */
export const TOOLS_WITH_ACCOUNTS: ReadonlySet<string> = new Set([
  "claude-code",
  "claude-desktop",
]);

/** First valid of `wanted`, `fallback`, then the first section. */
export function resolveSection(
  sections: readonly ToolSection[],
  wanted: string | undefined,
  fallback: string,
) {
  if (wanted && sections.some((s) => s.id === wanted)) return wanted;
  if (sections.some((s) => s.id === fallback)) return fallback;
  return sections[0].id;
}

/**
 * Section switcher under a tool page's header: same meaning and current-item
 * mark (ink bar on the left edge) as the design's sidebar items.
 */
export function ToolSectionNav({
  label,
  sections,
  current,
  onChange,
  ariaLabels,
  disabled,
}: {
  label: string;
  sections: readonly ToolSection[];
  current: string;
  onChange: (id: string) => void;
  /** Accessible names for items whose visible label is not specific enough. */
  ariaLabels?: Partial<Record<string, string>>;
  /** Items that cannot be opened from here. */
  disabled?: readonly string[];
}) {
  return (
    <nav className="tool-section-nav v3-tool-sections" aria-label={label}>
      {sections.map(({ id, label: text, icon: Icon }) => (
        <button
          key={id}
          type="button"
          data-section={id}
          aria-label={ariaLabels?.[id]}
          disabled={disabled?.includes(id)}
          aria-current={current === id ? "page" : undefined}
          onClick={() => onChange(id)}
        >
          <Icon size={14} aria-hidden="true" />
          {text}
        </button>
      ))}
    </nav>
  );
}
