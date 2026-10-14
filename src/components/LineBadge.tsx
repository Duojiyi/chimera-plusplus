import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import {
  isOfficialLine,
  lineBadgeText,
  type LineBadgeSource,
} from "@/utils/lineBadge";
import "./LineBadge.css";

export type LineIdentitySource = LineBadgeSource & {
  iconColor?: string | null;
};

// The six line colours the editor offers. They map to `--id-*` so the badge
// switches to the lighter identity colour (with dark text) in the dark theme.
const IDENTITY_TOKENS: Record<string, string> = {
  "#537197": "--id-cobalt",
  "#776894": "--id-violet",
  "#8f607a": "--id-magenta",
  "#357b7f": "--id-teal",
  "#61774b": "--id-moss",
  "#8f6446": "--id-ochre",
};

const WIDE_CHAR =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** A third-party line's identity colour, as a CSS value. */
export function lineIdentityColor(line: LineIdentitySource): string {
  const hex = line.iconColor?.trim().toLowerCase() ?? "";
  if (!hex) return "var(--id-cobalt)";
  const token = IDENTITY_TOKENS[hex];
  return token ? `var(${token})` : hex;
}

function lineIdentityInk(line: LineIdentitySource): string {
  const hex = line.iconColor?.trim().toLowerCase() ?? "";
  // A colour outside the palette keeps the light-theme pairing in both themes.
  return !hex || IDENTITY_TOKENS[hex] ? "var(--badge-line-fg)" : "#fdfdfe";
}

/**
 * The coloured identity mark of a line: square for third-party lines, round
 * for official accounts, text from `lineBadgeText`. Every surface that shows a
 * line uses this so one line never looks different in two places.
 */
export function LineBadge({
  line,
  size = "md",
  onPlate = false,
  label,
  className,
}: {
  line: LineIdentitySource;
  /** sm 20px (sidebar, title bar, palette), md 24px (lists), lg 40px (signboard). */
  size?: "sm" | "md" | "lg";
  /** On graphite surfaces the official badge needs a ring to stay visible. */
  onPlate?: boolean;
  /** Accessible name when the badge is the only thing naming the line. */
  label?: string;
  className?: string;
}) {
  const text = lineBadgeText(line);
  const official = isOfficialLine(line);
  // Two CJK or three Latin characters need a smaller size to fit the square.
  const wide =
    Array.from(text).reduce(
      (units, char) => units + (WIDE_CHAR.test(char) ? 2 : 1),
      0,
    ) > 2;
  const style = official
    ? undefined
    : ({
        "--line-badge-bg": lineIdentityColor(line),
        "--line-badge-fg": lineIdentityInk(line),
      } as CSSProperties);
  return (
    <span
      className={cn("line-badge", className)}
      data-size={size}
      data-official={official || undefined}
      data-wide={wide || undefined}
      data-on-plate={onPlate || undefined}
      style={style}
      {...(label
        ? { role: "img", "aria-label": label, title: label }
        : { "aria-hidden": true })}
    >
      {text}
    </span>
  );
}
