import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export const GROK_BUILD_DEFAULT_MODEL = "grok-4.5";
export const GROK_BUILD_DEFAULT_API_BACKEND = "responses";
export const GROK_BUILD_DEFAULT_CONTEXT_WINDOW = 500000;
/** api_backend values the Grok CLI understands (see grokApiBackendFromApiFormat). */
export const GROK_BUILD_API_BACKENDS = [
  "responses",
  "chat_completions",
  "messages",
] as const;
/** Returned by validateGrokBuildConfig when only the credential is absent:
 * a required field the user has not filled in yet, not a broken file. */
export const GROK_BUILD_MISSING_KEY_ERROR = "Missing api_key or env_key";

export interface GrokBuildConfigValues {
  /** Client-visible profile selected by [models].default. */
  model: string;
  /** Real model sent to the upstream provider. */
  upstreamModel?: string;
  baseUrl: string;
  name: string;
  apiKey: string;
  envKey?: string;
  apiBackend: string;
  contextWindow: number;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown, fallback = "") =>
  typeof value === "string" ? value : fallback;

export function parseGrokBuildConfig(
  configToml: string | undefined,
  fallbackName = "",
): GrokBuildConfigValues {
  const fallback: GrokBuildConfigValues = {
    model: GROK_BUILD_DEFAULT_MODEL,
    upstreamModel: GROK_BUILD_DEFAULT_MODEL,
    baseUrl: "",
    name: fallbackName,
    apiKey: "",
    apiBackend: GROK_BUILD_DEFAULT_API_BACKEND,
    contextWindow: GROK_BUILD_DEFAULT_CONTEXT_WINDOW,
  };

  if (!configToml?.trim()) return fallback;

  try {
    const root = asRecord(parseToml(configToml));
    const models = asRecord(root?.models);
    const defaultModel = asString(models?.default, GROK_BUILD_DEFAULT_MODEL);
    const modelTables = asRecord(root?.model);
    const selectedModel = asRecord(modelTables?.[defaultModel]);
    const rawContextWindow = selectedModel?.context_window;

    return {
      model: defaultModel,
      upstreamModel: asString(selectedModel?.model, defaultModel),
      baseUrl: asString(selectedModel?.base_url),
      name: asString(selectedModel?.name, fallbackName),
      apiKey: asString(selectedModel?.api_key),
      envKey: asString(selectedModel?.env_key),
      apiBackend: asString(
        selectedModel?.api_backend,
        GROK_BUILD_DEFAULT_API_BACKEND,
      ),
      contextWindow:
        typeof rawContextWindow === "number" &&
        Number.isInteger(rawContextWindow) &&
        rawContextWindow > 0
          ? rawContextWindow
          : GROK_BUILD_DEFAULT_CONTEXT_WINDOW,
    };
  } catch {
    return fallback;
  }
}

export function buildGrokBuildConfig(values: GrokBuildConfigValues): string {
  return updateGrokBuildConfig(undefined, values);
}

/** Result of applying the structured fields to a config.toml draft. */
export interface GrokBuildConfigUpdate {
  text: string;
  /** The draft had comments and the update could not keep them. */
  droppedComments: boolean;
}

/** Keys the structured fields own in the selected `[model."<profile>"]`. */
const PROFILE_KEYS = [
  "model",
  "base_url",
  "name",
  "api_key",
  "env_key",
  "api_backend",
  "context_window",
] as const;

/**
 * The structured fields applied to a draft. Lines of keys that did not change
 * are kept byte for byte, so the user's comments, ordering and other tables
 * survive; only when the file is written in a shape that cannot be edited in
 * place (dotted keys, inline tables, duplicate tables) is it regenerated, and
 * `droppedComments` then says whether comments were lost.
 */
export function planGrokBuildConfigUpdate(
  configToml: string | undefined,
  values: GrokBuildConfigValues,
): GrokBuildConfigUpdate {
  const profile = values.model.trim() || GROK_BUILD_DEFAULT_MODEL;
  const upstreamModel = values.upstreamModel?.trim() || profile;
  // Never replace an invalid draft with an empty config: it may contain user MCP settings.
  const config =
    asRecord(configToml?.trim() ? parseToml(configToml) : {}) ?? {};

  const existingModels = asRecord(config.models) ?? {};
  const previousProfile = asString(existingModels.default, profile);
  config.models = { ...existingModels, default: profile };

  const modelTables = asRecord(config.model) ?? {};
  const existingSelected =
    asRecord(modelTables[profile]) ??
    asRecord(modelTables[previousProfile]) ??
    {};
  const apiKey = values.apiKey.trim();
  const envKey =
    values.envKey?.trim() || asString(existingSelected.env_key).trim();
  const updatedSelected: Record<string, unknown> = {
    ...existingSelected,
    model: upstreamModel,
    base_url: values.baseUrl.trim(),
    name: values.name.trim(),
    api_backend: values.apiBackend.trim() || GROK_BUILD_DEFAULT_API_BACKEND,
    context_window:
      Number.isInteger(values.contextWindow) && values.contextWindow > 0
        ? values.contextWindow
        : GROK_BUILD_DEFAULT_CONTEXT_WINDOW,
  };
  if (apiKey) updatedSelected.api_key = apiKey;
  else delete updatedSelected.api_key;
  if (envKey) updatedSelected.env_key = envKey;
  else delete updatedSelected.env_key;

  config.model = {
    ...modelTables,
    [profile]: updatedSelected,
  };

  if (previousProfile !== profile && previousProfile in modelTables) {
    delete (config.model as Record<string, unknown>)[previousProfile];
  }

  const regenerated = `${stringifyToml(config).trim()}\n`;
  if (!configToml?.trim()) return { text: regenerated, droppedComments: false };
  // Nothing changed: keep the user's text exactly, whatever its layout.
  if (canonicalJson(parseToml(configToml)) === canonicalJson(config)) {
    return { text: configToml, droppedComments: false };
  }

  const patched = patchGrokConfigText(configToml, {
    profile,
    previousProfile,
    selected: updatedSelected,
    current: existingSelected,
    currentDefault: existingModels.default,
  });
  if (patched !== null) {
    try {
      if (canonicalJson(parseToml(patched)) === canonicalJson(config)) {
        return { text: patched, droppedComments: false };
      }
    } catch {
      // Fall through to the regenerated file.
    }
  }
  return { text: regenerated, droppedComments: hasTomlComments(configToml) };
}

export function updateGrokBuildConfig(
  configToml: string | undefined,
  values: GrokBuildConfigValues,
): string {
  return planGrokBuildConfigUpdate(configToml, values).text;
}

/**
 * True when the draft has comments that an edit of the structured fields
 * would remove (the file would have to be regenerated). Lets the editor warn
 * before any comment is lost.
 */
export function grokBuildConfigEditDropsComments(configToml: string): boolean {
  if (!hasTomlComments(configToml)) return false;
  let current: GrokBuildConfigValues;
  try {
    parseToml(configToml);
    current = parseGrokBuildConfig(configToml);
  } catch {
    return false;
  }
  // Change every structured field so each edit path is exercised once.
  const probe: GrokBuildConfigValues = {
    ...current,
    upstreamModel: `${current.upstreamModel ?? current.model}-probe`,
    baseUrl: `${current.baseUrl}/probe`,
    name: `${current.name} probe`,
    apiKey: `${current.apiKey}probe`,
    apiBackend:
      current.apiBackend === "responses" ? "chat_completions" : "responses",
    contextWindow: current.contextWindow + 1,
  };
  try {
    return planGrokBuildConfigUpdate(configToml, probe).droppedComments;
  } catch {
    return true;
  }
}

// --- In-place TOML edits ----------------------------------------------------

type KeyPath = string[];

interface TomlHeader {
  kind: "header";
  start: number;
  /** Index of the line break after the header line (or the text length). */
  end: number;
  path: KeyPath;
  array: boolean;
  indent: string;
  comment: string;
}

interface TomlKeyValue {
  kind: "kv";
  start: number;
  end: number;
  path: KeyPath;
  valueStart: number;
  valueEnd: number;
  indent: string;
}

type TomlEntry = TomlHeader | TomlKeyValue;

interface TomlSection {
  header: TomlHeader | null;
  entries: TomlKeyValue[];
  /** First index after the section (the next header's start, or the end). */
  end: number;
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/** A TOML key as written in a header or key/value line. */
function formatTomlKey(key: string): string {
  return BARE_KEY.test(key) ? key : tomlString(key);
}

function tomlString(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function tomlValue(value: unknown): string | null {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "number" && Number.isInteger(value))
    return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
}

function sameValue(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    const record = asRecord(item);
    if (!record || item instanceof Date) return item;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  });
}

/** Index just after a quoted string starting at `i`, or null if unterminated. */
function scanString(text: string, i: number): number | null {
  if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
    const quote = text[i];
    const triple = quote.repeat(3);
    let j = i + 3;
    while (j < text.length) {
      if (quote === '"' && text[j] === "\\") {
        j += 2;
        continue;
      }
      if (text.startsWith(triple, j)) {
        let close = j + 3;
        // Up to two quotes may end the content right before the delimiter.
        while (close < text.length && text[close] === quote && close - j < 5)
          close += 1;
        return close;
      }
      j += 1;
    }
    return null;
  }
  const quote = text[i];
  let j = i + 1;
  while (j < text.length && text[j] !== quote && text[j] !== "\n") {
    if (quote === '"' && text[j] === "\\") j += 1;
    j += 1;
  }
  return text[j] === quote ? j + 1 : null;
}

/** Index just after the value starting at `i` (may span lines). */
function scanValue(text: string, i: number): number | null {
  const first = text[i];
  if (first === '"' || first === "'") return scanString(text, i);
  if (first === "[" || first === "{") {
    let depth = 0;
    let j = i;
    while (j < text.length) {
      const char = text[j];
      if (char === '"' || char === "'") {
        const next = scanString(text, j);
        if (next === null) return null;
        j = next;
        continue;
      }
      if (char === "#") {
        const lineEnd = text.indexOf("\n", j);
        j = lineEnd === -1 ? text.length : lineEnd;
        continue;
      }
      if (char === "[" || char === "{") depth += 1;
      if (char === "]" || char === "}") {
        depth -= 1;
        if (depth === 0) return j + 1;
      }
      j += 1;
    }
    return null;
  }
  let j = i;
  while (j < text.length && text[j] !== "\n" && text[j] !== "#") j += 1;
  while (j > i && /[ \t\r]/.test(text[j - 1])) j -= 1;
  return j > i ? j : null;
}

/** A dotted key starting at `i`, up to `stop` (outside quotes). */
function scanKey(
  text: string,
  i: number,
  stop: (char: string) => boolean,
): { path: KeyPath; end: number } | null {
  const path: KeyPath = [];
  let j = i;
  const skipSpace = () => {
    while (j < text.length && (text[j] === " " || text[j] === "\t")) j += 1;
  };
  for (;;) {
    skipSpace();
    const char = text[j];
    if (char === '"' || char === "'") {
      if (text.startsWith(char.repeat(3), j)) return null;
      const end = scanString(text, j);
      if (end === null) return null;
      const raw = text.slice(j, end);
      if (char === '"') {
        try {
          path.push(JSON.parse(raw) as string);
        } catch {
          return null;
        }
      } else {
        path.push(raw.slice(1, -1));
      }
      j = end;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(text.slice(j, j + 256));
      if (!match) return null;
      path.push(match[0]);
      j += match[0].length;
    }
    skipSpace();
    if (j >= text.length || stop(text[j])) return { path, end: j };
    if (text[j] !== ".") return null;
    j += 1;
  }
}

/** Headers and key/value lines of a TOML text, or null if it is not plain. */
function scanTomlEntries(text: string): TomlEntry[] | null {
  const entries: TomlEntry[] = [];
  let pos = 0;
  while (pos < text.length) {
    const nextBreak = text.indexOf("\n", pos);
    const lineEnd = nextBreak === -1 ? text.length : nextBreak;
    const line = text.slice(pos, lineEnd);
    const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
    const body = line.slice(indent.length).replace(/\r$/, "");
    if (!body || body.startsWith("#")) {
      pos = lineEnd + 1;
      continue;
    }
    const keyStart = pos + indent.length;
    if (body.startsWith("[")) {
      const array = body.startsWith("[[");
      const key = scanKey(
        text,
        keyStart + (array ? 2 : 1),
        (char) => char === "]",
      );
      if (!key) return null;
      const close = array ? "]]" : "]";
      if (!text.startsWith(close, key.end)) return null;
      const rest = text.slice(key.end + close.length, lineEnd);
      const comment = /^[ \t]*(#.*)?\r?$/.exec(rest);
      if (!comment) return null;
      entries.push({
        kind: "header",
        start: pos,
        end: lineEnd,
        path: key.path,
        array,
        indent,
        comment: comment[1] ?? "",
      });
      pos = lineEnd + 1;
      continue;
    }
    const key = scanKey(text, keyStart, (char) => char === "=");
    if (!key || text[key.end] !== "=") return null;
    let valueStart = key.end + 1;
    while (text[valueStart] === " " || text[valueStart] === "\t")
      valueStart += 1;
    const valueEnd = scanValue(text, valueStart);
    if (valueEnd === null) return null;
    const afterBreak = text.indexOf("\n", valueEnd);
    const end = afterBreak === -1 ? text.length : afterBreak;
    if (!/^[ \t]*(#.*)?\r?$/.test(text.slice(valueEnd, end))) return null;
    entries.push({
      kind: "kv",
      start: pos,
      end,
      path: key.path,
      valueStart,
      valueEnd,
      indent,
    });
    pos = end + 1;
  }
  return entries;
}

function sectionsOf(entries: TomlEntry[], length: number): TomlSection[] {
  const sections: TomlSection[] = [{ header: null, entries: [], end: length }];
  for (const entry of entries) {
    if (entry.kind === "header") {
      sections[sections.length - 1].end = entry.start;
      sections.push({ header: entry, entries: [], end: length });
    } else {
      sections[sections.length - 1].entries.push(entry);
    }
  }
  return sections;
}

const samePath = (a: KeyPath, b: KeyPath) =>
  a.length === b.length && a.every((part, index) => part === b[index]);

/** A `#` outside every string: a comment line or a trailing comment. */
function hasTomlComments(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '"' || char === "'") {
      const end = scanString(text, i);
      if (end === null) return text.includes("#", i);
      i = end;
      continue;
    }
    if (char === "#") return true;
    i += 1;
  }
  return false;
}

interface ProfilePatch {
  profile: string;
  previousProfile: string;
  selected: Record<string, unknown>;
  current: Record<string, unknown>;
  currentDefault: unknown;
}

/**
 * Applies the structured values to the text in place. Returns null when the
 * text uses a layout this does not edit (the caller then regenerates it).
 */
function patchGrokConfigText(text: string, patch: ProfilePatch): string | null {
  const entries = scanTomlEntries(text);
  if (!entries) return null;
  const sections = sectionsOf(entries, text.length);
  const tables = (path: KeyPath) =>
    sections.filter(
      (section) =>
        section.header &&
        !section.header.array &&
        samePath(section.header.path, path),
    );
  // Keys must be defined only by the expected tables, never by dotted keys
  // or inline tables elsewhere.
  const definedElsewhere = entries.some(
    (entry) =>
      entry.kind === "kv" &&
      sections.find((section) => section.entries.includes(entry))?.header ===
        null &&
      (entry.path[0] === "models" || entry.path[0] === "model"),
  );
  if (definedElsewhere) return null;
  const nested = sections.some(
    (section) =>
      section.header &&
      section.header.path.length === 1 &&
      section.header.path[0] === "model" &&
      section.entries.length > 0,
  );
  if (nested) return null;

  const lineBreak = text.includes("\r\n") ? "\r\n" : "\n";
  // Where a line's content ends: before its "\r" in CRLF text.
  const contentEnd = (index: number) =>
    text[index - 1] === "\r" ? index - 1 : index;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const appended: string[] = [];

  const setKeys = (
    section: TomlSection,
    wanted: Record<string, unknown>,
    current: Record<string, unknown>,
    keys: readonly string[],
  ): boolean => {
    const inserts: string[] = [];
    for (const key of keys) {
      const lines = section.entries.filter((entry) =>
        samePath(entry.path, [key]),
      );
      if (lines.length > 1) return false;
      if (
        section.entries.some(
          (entry) => entry.path.length > 1 && entry.path[0] === key,
        )
      )
        return false;
      const [line] = lines;
      const value = wanted[key];
      if (value === undefined) {
        if (line) {
          const next = text.indexOf("\n", line.end);
          edits.push({
            start: line.start,
            end: next === -1 ? text.length : next + 1,
            text: "",
          });
        }
        continue;
      }
      if (line && sameValue(current[key], value)) continue;
      const literal = tomlValue(value);
      if (literal === null) return false;
      if (line) {
        edits.push({
          start: line.valueStart,
          end: line.valueEnd,
          text: literal,
        });
      } else {
        inserts.push(`${formatTomlKey(key)} = ${literal}`);
      }
    }
    if (inserts.length) {
      const anchor =
        section.entries[section.entries.length - 1] ?? section.header;
      if (!anchor) return false;
      const indent = section.entries[0]?.indent ?? "";
      const at = contentEnd(anchor.end);
      edits.push({
        start: at,
        end: at,
        text: inserts.map((line) => `${lineBreak}${indent}${line}`).join(""),
      });
    }
    return true;
  };

  // [models] default
  const modelsTables = tables(["models"]);
  if (modelsTables.length > 1) return null;
  if (modelsTables.length === 1) {
    if (
      !setKeys(
        modelsTables[0],
        { default: patch.profile },
        { default: patch.currentDefault },
        ["default"],
      )
    )
      return null;
  } else {
    appended.push(`[models]`, `default = ${tomlString(patch.profile)}`);
  }

  // [model."<profile>"]
  const profileTables = tables(["model", patch.profile]);
  const previousTables =
    patch.previousProfile !== patch.profile
      ? tables(["model", patch.previousProfile])
      : [];
  if (profileTables.length > 1 || previousTables.length > 1) return null;
  const target = profileTables[0] ?? previousTables[0];
  if (target?.header) {
    if (!profileTables.length) {
      // Rename the previous profile's table in place.
      const header = target.header;
      edits.push({
        start: header.start,
        end: contentEnd(header.end),
        text: `${header.indent}[model.${formatTomlKey(patch.profile)}]${
          header.comment ? ` ${header.comment}` : ""
        }`,
      });
    } else if (previousTables.length) {
      // The previous profile's table is replaced by the selected one.
      const previous = previousTables[0];
      edits.push({
        start: previous.header!.start,
        end: previous.end,
        text: "",
      });
    }
    if (!setKeys(target, patch.selected, patch.current, PROFILE_KEYS))
      return null;
  } else {
    appended.push("", `[model.${formatTomlKey(patch.profile)}]`);
    for (const key of PROFILE_KEYS) {
      const value = patch.selected[key];
      if (value === undefined) continue;
      const literal = tomlValue(value);
      if (literal === null) return null;
      appended.push(`${formatTomlKey(key)} = ${literal}`);
    }
    // Keys of an adopted table that the fields do not own stay with it.
    for (const [key, value] of Object.entries(patch.selected)) {
      if ((PROFILE_KEYS as readonly string[]).includes(key)) continue;
      const literal = tomlValue(value);
      if (literal === null) return null;
      appended.push(`${formatTomlKey(key)} = ${literal}`);
    }
  }

  let result = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  if (appended.length) {
    const trimmed = result.replace(/\s+$/, "");
    result = `${trimmed}${trimmed ? `${lineBreak}${lineBreak}` : ""}${appended
      .join(lineBreak)
      .replace(/^(\r?\n)+/, "")}${lineBreak}`;
  }
  return result;
}

export function validateGrokBuildConfig(configToml: string): string | null {
  if (!configToml.trim()) return "config.toml must not be empty";
  try {
    const root = asRecord(parseToml(configToml));
    const models = asRecord(root?.models);
    const profile = asString(models?.default).trim();
    const selected = asRecord(asRecord(root?.model)?.[profile]);
    if (!profile || !selected) return "Missing [models] default model table";
    for (const field of ["model", "base_url", "name", "api_backend"]) {
      if (!asString(selected[field]).trim()) return `Missing ${field}`;
    }
    if (
      !asString(selected.api_key).trim() &&
      !asString(selected.env_key).trim()
    ) {
      return GROK_BUILD_MISSING_KEY_ERROR;
    }
    const contextWindow = selected.context_window;
    if (
      typeof contextWindow !== "number" ||
      !Number.isInteger(contextWindow) ||
      contextWindow <= 0
    ) {
      return "context_window must be a positive integer";
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid TOML";
  }
}

export function extractGrokBuildBaseUrl(configToml: string): string {
  return parseGrokBuildConfig(configToml).baseUrl;
}
