import { Monitor, Terminal } from "lucide-react";
import type { AppId } from "@/lib/api/types";
import { ProviderIcon } from "@/components/ProviderIcon";
import { hasIcon, isUrlIcon } from "@/icons/extracted";
import { isOfficialLine, type LineBadgeSource } from "@/utils/lineBadge";
import { cn } from "@/lib/utils";
import "./AppGlyph.css";

/** Canonical brand icon key in src/icons/extracted for every supported tool. */
const APP_ICON_NAME: Record<AppId, string> = {
  claude: "claude",
  "claude-desktop": "claude",
  codex: "openai",
  gemini: "gemini",
  grokbuild: "grok",
  opencode: "opencode",
  openclaw: "openclaw",
  hermes: "hermes",
  pi: "pi",
  mcode: "minimax",
  kimi: "kimi",
  dsh: "deepseek",
  agy: "antigravity",
  omp: "omp",
  copilot: "githubcopilot",
  workbuddy: "workbuddy",
  codebuddy: "codebuddy",
};

// Claude Code and Claude Desktop share the Claude starburst; a small corner
// badge distinguishes terminal vs desktop (adapted from CC Switch AppGlyph).
const APP_BADGE_ICON: Partial<Record<AppId, typeof Terminal>> = {
  claude: Terminal,
  "claude-desktop": Monitor,
};

const TOOL_ID_ALIAS: Record<string, AppId> = {
  "claude-code": "claude",
  "gemini-cli": "gemini",
};

export function resolveAppId(raw: string): AppId | undefined {
  const key = TOOL_ID_ALIAS[raw] ?? raw;
  return Object.hasOwn(APP_ICON_NAME, key) ? (key as AppId) : undefined;
}

export interface AppGlyphProps {
  app: string;
  /** Icon size in px (default 18). */
  size?: number;
  /** Wrap inside a soft frosted rounded-square plate. */
  plated?: boolean;
  /** Plate box size in px when plated=true (default size + 12). */
  plateSize?: number;
  className?: string;
}

/** Tool brand icon with Claude Code / Desktop corner differentiator. */
export function AppGlyph({
  app,
  size = 18,
  plated = false,
  plateSize,
  className,
}: AppGlyphProps) {
  const appId = resolveAppId(app);
  const iconKey = appId ? APP_ICON_NAME[appId] : undefined;
  const BadgeIcon = appId ? APP_BADGE_ICON[appId] : undefined;
  const box = plateSize ?? size + 12;

  const glyph = (
    <span
      aria-hidden="true"
      className={cn("app-glyph", !plated && className)}
      style={{ width: size + 2, height: size + 2 }}
    >
      <ProviderIcon
        icon={iconKey}
        name={app}
        size={size}
        showFallback={!iconKey}
      />
      {BadgeIcon && (
        <span className="app-glyph-corner">
          <BadgeIcon
            size={Math.max(8, Math.round(size * 0.48))}
            strokeWidth={2.75}
          />
        </span>
      )}
    </span>
  );

  if (!plated) return glyph;

  return (
    <span
      aria-hidden="true"
      className={cn("app-glyph-plate", className)}
      style={{ width: box, height: box }}
    >
      {glyph}
    </span>
  );
}

/** Single crisp monogram character (matches Codex's flagship 1-char tiles). */
export function singleCharMonogram(name?: string | null): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "•";
  const first = Array.from(trimmed)[0] ?? "•";
  return first.toUpperCase();
}

export interface RouteGlyphProps {
  appId: string;
  line: LineBadgeSource & {
    icon?: string | null;
    iconColor?: string | null;
  };
  /** Visual tile size in px: 24 (tray), 28 (table), 38 (hero signboard). */
  size?: 24 | 28 | 38;
  className?: string;
}

/**
 * Unified route avatar across ToolView and TrayPanel:
 * - Official routes render the tool's real brand icon inside a frosted tile.
 * - Custom routes with an explicit known brand icon render that brand icon.
 * - Other custom routes render a clean 1-character obsidian monogram (never
 *   cramming 2 characters or "官" into a tiny square).
 */
export function RouteGlyph({
  appId,
  line,
  size = 28,
  className,
}: RouteGlyphProps) {
  const official = isOfficialLine(line);
  const iconSize = size === 38 ? 22 : size === 28 ? 17 : 15;

  if (official && resolveAppId(appId)) {
    return (
      <AppGlyph
        app={appId}
        size={iconSize}
        plated
        plateSize={size}
        className={cn("route-glyph-official", className)}
      />
    );
  }

  const customIcon = line.icon?.trim();
  if (customIcon && (hasIcon(customIcon) || isUrlIcon(customIcon))) {
    return (
      <span
        aria-hidden="true"
        className={cn("app-glyph-plate route-glyph-brand", className)}
        style={{ width: size, height: size }}
      >
        <ProviderIcon
          icon={customIcon}
          name={line.name ?? ""}
          size={iconSize}
          showFallback={false}
        />
      </span>
    );
  }

  const customBadge =
    typeof line.meta?.badgeText === "string" && line.meta.badgeText.trim()
      ? Array.from(line.meta.badgeText.trim())[0].toUpperCase()
      : null;
  const char = customBadge ?? singleCharMonogram(line.name);

  return (
    <span
      aria-hidden="true"
      className={cn("route-glyph-monogram", className)}
      data-size={size}
    >
      {char}
    </span>
  );
}
