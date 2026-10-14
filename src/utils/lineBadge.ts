import type { Provider } from "@/types";

/**
 * Line badge text: the two-character code inside a line's coloured square
 * (line table, signboards, editor preview). Every surface reads it from here
 * so one line never shows two different codes.
 */

export interface LineBadgeSource {
  id?: string;
  name?: string | null;
  category?: string | null;
  meta?: Provider["meta"] | null;
}

const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_GLOBAL = new RegExp(CJK.source, "gu");
// Acronym runs ("GLM", "AI"), capitalised or lower-case words, digit runs.
const WORD = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g;
const MAX_CJK = 2;
const MAX_LATIN = 3;

const chars = (value: string) => Array.from(value);

function customBadgeText(meta: unknown): string {
  if (!meta || typeof meta !== "object") return "";
  const value = (meta as { badgeText?: unknown }).badgeText;
  return typeof value === "string" ? value : "";
}

/** Clamp user input to what fits the badge: 2 CJK characters, otherwise 3. */
export function normalizeLineBadgeText(value: string): string {
  const trimmed = value.trim();
  return chars(trimmed)
    .slice(0, CJK.test(trimmed) ? MAX_CJK : MAX_LATIN)
    .join("")
    .trim();
}

export function isOfficialLine(source: LineBadgeSource): boolean {
  return source.category === "official" || source.id === "codex-official";
}

function latinBadge(name: string): string | null {
  const words = (name.match(WORD) ?? []).filter((word) =>
    /[A-Za-z]/.test(word),
  );
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  if (words.length === 1) {
    const [word] = words;
    if (word.length > 1 && word === word.toUpperCase()) {
      return word.slice(0, 2);
    }
    return word[0].toUpperCase() + word.slice(1, 2).toLowerCase();
  }
  return null;
}

/** The generated code, ignoring any badge text the user set. */
export function autoLineBadgeText(source: LineBadgeSource): string {
  if (isOfficialLine(source)) return "官";
  const name = (source.name ?? "").trim();
  if (!name) return "未";
  const cjk = name.match(CJK_GLOBAL) ?? [];
  if (CJK.test(chars(name)[0])) return cjk.slice(0, MAX_CJK).join("");
  const latin = latinBadge(name);
  if (latin) return latin;
  if (cjk.length) return cjk.slice(0, MAX_CJK).join("");
  return chars(name).slice(0, 2).join("").toUpperCase();
}

/** The badge shown for a line: the user's own text wins over the generated one. */
export function lineBadgeText(source: LineBadgeSource): string {
  return (
    normalizeLineBadgeText(customBadgeText(source.meta)) ||
    autoLineBadgeText(source)
  );
}
