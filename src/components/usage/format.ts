export function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function fmtInt(
  value: unknown,
  locale?: string,
  fallback: string = "--",
): string {
  const num = parseFiniteNumber(value);
  if (num == null) return fallback;
  return new Intl.NumberFormat(locale).format(Math.trunc(num));
}

export function fmtUsd(
  value: unknown,
  digits: number,
  fallback: string = "--",
): string {
  const num = parseFiniteNumber(value);
  if (num == null) return fallback;
  return `$${num.toFixed(digits)}`;
}

function normalizeLanguageTag(language: string): string {
  return language.toLowerCase().replace(/_/g, "-");
}

function isTraditionalChineseLanguage(normalizedLanguage: string): boolean {
  return (
    normalizedLanguage === "zh-tw" ||
    normalizedLanguage.startsWith("zh-hant") ||
    normalizedLanguage.startsWith("zh-hk") ||
    normalizedLanguage.startsWith("zh-mo")
  );
}

/** Latency in seconds with one decimal; a missing or zero value reads "—". */
export function formatSeconds(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "—";
  return `${(ms / 1000).toFixed(1)} 秒`;
}

/**
 * Token counts inside table cells. One fixed precision per unit keeps a
 * right-aligned column readable (13.0 万 above 14.9 万); counts below 10,000
 * stay exact. Zero is "0".
 */
export function formatTokenCell(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const tokens = Math.round(value);
  if (tokens < 1e4) return tokens.toLocaleString("zh-CN");
  // Round first so 99,999,999 reads as 1.00 亿 rather than 10,000.0 万.
  const wan = Math.round(tokens / 1e3) / 10;
  if (wan < 1e4)
    return `${wan.toLocaleString("zh-CN", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} 万`;
  return `${(tokens / 1e8).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 亿`;
}

/** Where a request record came from, in the words the rest of the app uses. */
export function usageSourceLabel(source?: string | null): string {
  if (!source || source === "proxy") return "本地代理";
  if (source.endsWith("_session")) return "会话记录";
  return source;
}

export function getLocaleFromLanguage(language: string): string {
  if (!language) return "en-US";
  const normalized = normalizeLanguageTag(language);
  if (normalized === "zh") return "zh-CN";
  if (isTraditionalChineseLanguage(normalized)) {
    return "zh-TW";
  }
  if (normalized.startsWith("zh")) return "zh-CN";
  if (normalized.startsWith("ja")) return "ja-JP";
  return "en-US";
}

interface I18nLike {
  resolvedLanguage?: string;
  language?: string;
}

export function getResolvedLang(i18n: I18nLike): string {
  return i18n.resolvedLanguage || i18n.language || "en";
}

/**
 * Token 数量的紧凑显示。
 *
 * Why: 中日文用户期待 "亿/万" 量纲；英文用户期待 K/M/B。共用同一份格式化
 * 逻辑避免 Hero 卡和分应用卡显示不一致。`compactDecimals=2` 用于 Hero
 * 大数副标（更精确），默认 1 位用于卡片副字段。
 */
export function formatTokensShort(
  value: number,
  lang: string,
  compactDecimals: 1 | 2 = 1,
): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const decimals = compactDecimals;
  const normalizedLang = normalizeLanguageTag(lang);
  if (isTraditionalChineseLanguage(normalizedLang)) {
    if (value >= 1e8) return `${(value / 1e8).toFixed(2)} 億`;
    if (value >= 1e4) return `${(value / 1e4).toFixed(decimals)} 萬`;
    return value.toLocaleString("zh-TW");
  }
  if (normalizedLang.startsWith("zh") || normalizedLang.startsWith("ja")) {
    if (value >= 1e8) return `${(value / 1e8).toFixed(2)} 亿`;
    if (value >= 1e4) return `${(value / 1e4).toFixed(decimals)} 万`;
    return value.toLocaleString();
  }
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(decimals)}K`;
  return value.toLocaleString();
}

const AXIS_TOKEN_UNITS: ReadonlyArray<readonly [number, string]> = [
  [1e11, "千亿"],
  [1e8, "亿"],
  [1e7, "千万"],
  [1e4, "万"],
];

/**
 * Short token-axis tick: the shortest of 千亿 / 亿 / 千万 / 万 that shows the
 * value with at most one decimal, so 50,000,000 reads "5千万" rather than
 * "50000k" or "5000万". Adapted from farion1231/cc-switch b76e83c3
 */
export function formatAxisTokens(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  const abs = Math.abs(value);
  if (abs < 1e4) return String(Math.round(value));
  let best: string | null = null;
  for (const [size, unit] of AXIS_TOKEN_UNITS) {
    if (abs < size) continue;
    const scaled = value / size;
    const tenths = Math.round(scaled * 10);
    if (Math.abs(scaled * 10 - tenths) > 1e-6) continue;
    const label = `${tenths / 10}${unit}`;
    if (best === null || label.length < best.length) best = label;
  }
  if (best !== null) return best;
  return abs >= 1e8
    ? `${(value / 1e8).toFixed(1)}亿`
    : `${(value / 1e4).toFixed(1)}万`;
}
