// Adapted from yynxxxxx/Codex-X (MIT), apps/desktop/src-tauri/src/context_config.rs
// `update_codex_context_window_inner` at 8f018fddd3ee1a68464e4df8765eb370ede0c76f:
// the 1M preset (window plus auto-compact limit) and the rule that turning it
// off only undoes the preset, never a hand-set value. Rewritten as a minimal
// text edit of root keys so comments, key order and every other byte of the
// line's config.toml survive.
import { parse as parseToml } from "smol-toml";

const WINDOW_KEY = "model_context_window";
const COMPACT_KEY = "model_auto_compact_token_limit";

export const ONE_MILLION_CONTEXT_WINDOW = 1_000_000;
// 90% of the window: the value Codex-X writes, and the share Codex itself
// compacts at when no limit is configured.
export const ONE_MILLION_AUTO_COMPACT_LIMIT = 900_000;

export interface CodexContextWindowState {
  /** Root `model_context_window` is exactly 1,000,000. */
  enabled: boolean;
  /** Root `model_context_window`; null when unset or not an integer. */
  contextWindow: number | null;
  /** Root `model_auto_compact_token_limit`; null when unset or not an integer. */
  autoCompactLimit: number | null;
  /** A root value differs from the preset; turning the switch off keeps it. */
  hasCustomValues: boolean;
  /** False when the text is not valid TOML or a key is not a plain root value. */
  editable: boolean;
}

/** One `key = value` statement of the root table; offsets index the text. */
interface RootStatement {
  key: string[];
  lineStart: number;
  valueStart: number;
  valueEnd: number;
  /** End of the statement's last line, before its line break. */
  lineEnd: number;
  /** Start of the following line; equals `lineEnd` at the end of the text. */
  next: number;
}

interface RootValue {
  statement?: RootStatement;
  /** The value as a safe integer; null when unset or of another type. */
  integer: number | null;
}

interface Analysis {
  window: RootValue;
  compact: RootValue;
  statements: RootStatement[];
  /** Offset of the root table: past a byte-order mark, if any. */
  top: number;
}

const BARE_KEY = /[A-Za-z0-9_-]+/y;

const skipBlanks = (text: string, i: number): number => {
  let at = i;
  while (text[at] === " " || text[at] === "\t") at += 1;
  return at;
};

/** Offset of the line break that ends the line holding `i`, or the end. */
const lineEndAt = (text: string, i: number): number => {
  const lf = text.indexOf("\n", i);
  if (lf === -1) return text.length;
  return lf > i && text[lf - 1] === "\r" ? lf - 1 : lf;
};

/** Offset just past a line break at `i`; `i` itself when there is none. */
const pastLineBreak = (text: string, i: number): number => {
  if (text[i] === "\n") return i + 1;
  if (text[i] === "\r" && text[i + 1] === "\n") return i + 2;
  return i;
};

const skipBasicString = (text: string, i: number): number => {
  for (let at = i + 1; at < text.length; at += 1) {
    const ch = text[at];
    if (ch === "\\") at += 1;
    else if (ch === '"') return at + 1;
    else if (ch === "\n" || ch === "\r") return -1;
  }
  return -1;
};

const skipLiteralString = (text: string, i: number): number => {
  for (let at = i + 1; at < text.length; at += 1) {
    if (text[at] === "'") return at + 1;
    if (text[at] === "\n" || text[at] === "\r") return -1;
  }
  return -1;
};

const skipMultilineString = (
  text: string,
  i: number,
  quote: '"' | "'",
): number => {
  const delimiter = quote.repeat(3);
  for (let at = i + 3; at < text.length; at += 1) {
    if (quote === '"' && text[at] === "\\") {
      at += 1;
    } else if (text.startsWith(delimiter, at)) {
      // Up to two quotes of content may sit right before the delimiter.
      let end = at + 3;
      while (end < at + 5 && text[end] === quote) end += 1;
      return end;
    }
  }
  return -1;
};

/** Arrays and inline tables may span lines and hold strings and comments. */
const skipBracketed = (text: string, i: number): number => {
  let depth = 0;
  let at = i;
  while (at < text.length) {
    const ch = text[at];
    if (ch === '"' || ch === "'") {
      at = skipValue(text, at);
      if (at === -1) return -1;
      continue;
    }
    if (ch === "#") {
      at = lineEndAt(text, at);
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
    at += 1;
  }
  return -1;
};

function skipValue(text: string, i: number): number {
  const ch = text[i];
  if (ch === '"' || ch === "'") {
    if (text.startsWith(ch.repeat(3), i)) {
      return skipMultilineString(text, i, ch);
    }
    return ch === '"' ? skipBasicString(text, i) : skipLiteralString(text, i);
  }
  if (ch === "[" || ch === "{") return skipBracketed(text, i);
  // Numbers, booleans and dates run to a comment or the end of the line.
  let end = i;
  while (end < text.length && !"#\r\n".includes(text[end])) end += 1;
  while (end > i && (text[end - 1] === " " || text[end - 1] === "\t")) {
    end -= 1;
  }
  return end > i ? end : -1;
}

const readKey = (
  text: string,
  start: number,
): { segments: string[]; end: number } | null => {
  const segments: string[] = [];
  let at = start;
  for (;;) {
    const ch = text[at];
    let end: number;
    if (ch === '"' || ch === "'") {
      end =
        ch === '"' ? skipBasicString(text, at) : skipLiteralString(text, at);
      if (end === -1) return null;
      // Escaped key names are left as written; such a key never matches ours.
      segments.push(text.slice(at + 1, end - 1));
    } else {
      BARE_KEY.lastIndex = at;
      const bare = BARE_KEY.exec(text);
      if (!bare) return null;
      end = at + bare[0].length;
      segments.push(bare[0]);
    }
    const dot = skipBlanks(text, end);
    if (text[dot] !== ".") return { segments, end };
    at = skipBlanks(text, dot + 1);
  }
};

const readStatement = (
  text: string,
  lineStart: number,
  start: number,
): Omit<RootStatement, "next"> | null => {
  const key = readKey(text, start);
  if (!key) return null;
  const equals = skipBlanks(text, key.end);
  if (text[equals] !== "=") return null;
  const valueStart = skipBlanks(text, equals + 1);
  const valueEnd = skipValue(text, valueStart);
  if (valueEnd === -1) return null;
  let lineEnd = skipBlanks(text, valueEnd);
  if (text[lineEnd] === "#") lineEnd = lineEndAt(text, lineEnd);
  return { key: key.segments, lineStart, valueStart, valueEnd, lineEnd };
};

/**
 * The statements of the root table, in order. Scanning stops at the first
 * table header, so keys of `[profiles.*]`, `[model_providers.*]` and every
 * other table are never seen. Null when the text has a shape this scanner
 * does not follow.
 */
const scanRootStatements = (
  text: string,
  top: number,
): RootStatement[] | null => {
  const statements: RootStatement[] = [];
  let at = top;
  while (at < text.length) {
    const lineStart = at;
    at = skipBlanks(text, at);
    if (text[at] === "[") break;
    let statement: Omit<RootStatement, "next"> | null = null;
    if (text[at] === "#") {
      at = lineEndAt(text, at);
    } else if (at < text.length && pastLineBreak(text, at) === at) {
      statement = readStatement(text, lineStart, at);
      if (!statement) return null;
      at = statement.lineEnd;
    }
    const next = pastLineBreak(text, at);
    if (next === at && at < text.length) return null;
    at = next;
    if (statement) statements.push({ ...statement, next });
  }
  return statements;
};

const parseRoot = (text: string): Record<string, unknown> | null => {
  try {
    // Big integers keep integers apart from floats such as `1000000.0`,
    // which Codex rejects for these keys.
    return parseToml(text, { integersAsBigInt: true });
  } catch {
    return null;
  }
};

const analyze = (text: string): Analysis | null => {
  const top = text.startsWith("\uFEFF") ? 1 : 0;
  const root = parseRoot(text.slice(top));
  const statements = root && scanRootStatements(text, top);
  if (!root || !statements) return null;
  const read = (key: string): RootValue | null => {
    if (!Object.hasOwn(root, key)) return { integer: null };
    const statement = statements.find(
      (candidate) => candidate.key.length === 1 && candidate.key[0] === key,
    );
    // Set, but not by a plain `key = value` line (a table): leave it alone.
    if (!statement) return null;
    const value = root[key];
    const integer = typeof value === "bigint" ? Number(value) : Number.NaN;
    return {
      statement,
      integer: Number.isSafeInteger(integer) ? integer : null,
    };
  };
  const window = read(WINDOW_KEY);
  const compact = read(COMPACT_KEY);
  return window && compact ? { window, compact, statements, top } : null;
};

const lineBreakOf = (text: string): string =>
  text.includes("\r\n") ? "\r\n" : "\n";

/** Insert `line` after `after`, or at the top of the root table. */
const insertLine = (
  text: string,
  after: RootStatement | undefined,
  line: string,
  top: number,
): string => {
  if (!after) {
    return `${text.slice(0, top)}${line}${lineBreakOf(text)}${text.slice(top)}`;
  }
  if (after.next === after.lineEnd) {
    // The statement ends the text without a line break of its own.
    return `${text.slice(0, after.lineEnd)}${lineBreakOf(text)}${line}`;
  }
  const lineBreak = text.slice(after.lineEnd, after.next);
  return `${text.slice(0, after.next)}${line}${lineBreak}${text.slice(after.next)}`;
};

/** Remove a statement's line together with exactly one line break. */
const removeLine = (text: string, statement: RootStatement): string => {
  if (statement.next > statement.lineEnd) {
    return text.slice(0, statement.lineStart) + text.slice(statement.next);
  }
  // The last line has no break of its own: take the one before it.
  let start = statement.lineStart;
  if (text[start - 1] === "\n") start -= text[start - 2] === "\r" ? 2 : 1;
  return text.slice(0, start) + text.slice(statement.lineEnd);
};

const turnOn = (text: string, analysis: Analysis): string => {
  const { window, compact, statements, top } = analysis;
  let next = text;
  if (!window.statement) {
    next = insertLine(
      next,
      statements.at(-1),
      `${WINDOW_KEY} = ${ONE_MILLION_CONTEXT_WINDOW}`,
      top,
    );
  } else if (window.integer !== ONE_MILLION_CONTEXT_WINDOW) {
    const { valueStart, valueEnd } = window.statement;
    next = `${next.slice(0, valueStart)}${ONE_MILLION_CONTEXT_WINDOW}${next.slice(valueEnd)}`;
  }
  // A limit that is already set wins, as upstream.
  if (compact.statement) return next;
  const written = analyze(next)?.window.statement;
  if (!written) return text;
  return insertLine(
    next,
    written,
    `${COMPACT_KEY} = ${ONE_MILLION_AUTO_COMPACT_LIMIT}`,
    top,
  );
};

const turnOff = (text: string, analysis: Analysis): string => {
  const { window, compact } = analysis;
  // Without the preset window nothing here was written by the switch.
  if (!window.statement || window.integer !== ONE_MILLION_CONTEXT_WINDOW) {
    return text;
  }
  const next = removeLine(text, window.statement);
  if (compact.integer !== ONE_MILLION_AUTO_COMPACT_LIMIT) return next;
  const limit = analyze(next)?.compact.statement;
  return limit ? removeLine(next, limit) : next;
};

/** Where the 1M switch of a Codex line stands, read from its config.toml. */
export function readContextWindowState(
  configToml: string,
): CodexContextWindowState {
  const analysis = analyze(configToml);
  if (!analysis) {
    return {
      enabled: false,
      contextWindow: null,
      autoCompactLimit: null,
      hasCustomValues: false,
      editable: false,
    };
  }
  const { window, compact } = analysis;
  const enabled = window.integer === ONE_MILLION_CONTEXT_WINDOW;
  const presetLimit =
    enabled && compact.integer === ONE_MILLION_AUTO_COMPACT_LIMIT;
  return {
    enabled,
    contextWindow: window.integer,
    autoCompactLimit: compact.integer,
    hasCustomValues:
      (window.statement !== undefined && !enabled) ||
      (compact.statement !== undefined && !presetLimit),
    editable: true,
  };
}

/**
 * Turn the 1M switch on or off in the root table of a line's config.toml.
 * On writes the 1,000,000 window and, unless a limit is already set, the
 * 900,000 auto-compact limit. Off removes only values equal to that preset.
 * Returns the text unchanged when it cannot be edited safely.
 */
export function applyOneMillionContext(
  configToml: string,
  enabled: boolean,
): string {
  const analysis = analyze(configToml);
  if (!analysis) return configToml;
  return enabled ? turnOn(configToml, analysis) : turnOff(configToml, analysis);
}
