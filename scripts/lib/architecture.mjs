// Static analysis for the backend layering rules (see docs/ARCHITECTURE.md).
//
// The analysis is deliberately text based: it blanks comments and literals with a
// small Rust-aware scanner, drops test-only items, and reads `crate::<module>`
// references. That is enough to enforce "lower layers never depend on higher
// layers" without compiling anything.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function parseBaseline(text) {
  const baseline = JSON.parse(text);
  const ruleNames = ["R1", "R2", "R4", "R5"];
  if (!baseline || Array.isArray(baseline) || typeof baseline !== "object" ||
      Object.keys(baseline).length !== ruleNames.length ||
      ruleNames.some((rule) => {
        const entries = baseline[rule];
        return !entries || Array.isArray(entries) || typeof entries !== "object" ||
          Object.values(entries).some((count) => !Number.isSafeInteger(count) || count < 0);
      })) {
    throw new Error("Invalid architecture baseline: expected R1/R2/R4/R5 maps of non-negative integer counts.");
  }
  return baseline;
}

export function baselineFromRef(root, ref) {
  try {
    const options = { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
    const commit = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], options).trim();
    return parseBaseline(execFileSync("git", ["show", `${commit}:scripts/architecture-baseline.json`], options));
  } catch (error) {
    throw new Error(`Cannot read a valid architecture baseline from trusted ref ${ref}: ${error.message}`);
  }
}

/**
 * Replaces comments and the contents of string/char literals with spaces. Newlines are kept.
 * With `keepStrings`, literals stay readable (path checks need them) and only comments are blanked.
 */
export function blankNonCode(source, { keepStrings = false } = {}) {
  const out = source.split("");
  const n = source.length;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const isIdent = (ch) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);
  let i = 0;
  while (i < n) {
    const c = source[i];
    const d = source[i + 1];
    if (c === "/" && d === "/") {
      let j = source.indexOf("\n", i);
      if (j < 0) j = n;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && d === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (source[j] === "/" && source[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (source[j] === "*" && source[j + 1] === "/") {
          depth--;
          j += 2;
        } else j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    // Raw strings: r"..", r#".."#, br#".."#
    if ((c === "r" || (c === "b" && d === "r")) && !isIdent(source[i - 1])) {
      let j = i + (c === "b" ? 2 : 1);
      let hashes = 0;
      while (source[j] === "#") {
        hashes++;
        j++;
      }
      if (source[j] === '"') {
        const close = '"' + "#".repeat(hashes);
        const end = source.indexOf(close, j + 1);
        const stop = end < 0 ? n : end + close.length;
        if (!keepStrings) blank(j + 1, end < 0 ? n : end);
        i = stop;
        continue;
      }
    }
    if (c === '"' || (c === "b" && d === '"' && !isIdent(source[i - 1]))) {
      let j = i + (c === "b" ? 2 : 1);
      while (j < n && source[j] !== '"') j += source[j] === "\\" ? 2 : 1;
      if (!keepStrings) blank(i + (c === "b" ? 2 : 1), Math.min(j, n));
      i = j + 1;
      continue;
    }
    if (c === "'") {
      // A char literal ('x', '\n', '\u{..}') or a lifetime ('a).
      if (d === "\\") {
        const end = source.indexOf("'", i + 3);
        if (end > 0 && end - i <= 12) {
          if (!keepStrings) blank(i + 1, end);
          i = end + 1;
          continue;
        }
      } else if (source[i + 2] === "'") {
        if (!keepStrings) blank(i + 1, i + 2);
        i += 3;
        continue;
      }
    }
    i++;
  }
  return out.join("");
}

/** Index just after the item that starts at `from` (attributes already skipped). */
function itemEnd(text, from) {
  let depth = 0;
  let sawBlock = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      depth++;
      sawBlock = true;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && sawBlock) {
        let k = i + 1;
        while (k < text.length && /\s/.test(text[k])) k++;
        return text[k] === ";" ? k + 1 : i + 1;
      }
    } else if (ch === ";" && depth === 0) {
      return i + 1;
    }
  }
  return text.length;
}

const TEST_ONLY_ATTR = /#\[cfg\(\s*(?:test|all\(\s*test\b[^\]]*)\)\]/g;

/** [start, end) ranges of every item guarded by `#[cfg(test)]` (or `cfg(all(test, ..))`). Input must be blanked already. */
export function testItemRanges(blanked) {
  const ranges = [];
  TEST_ONLY_ATTR.lastIndex = 0;
  let match;
  while ((match = TEST_ONLY_ATTR.exec(blanked)) !== null) {
    let from = match.index + match[0].length;
    for (;;) {
      const rest = blanked.slice(from);
      const attr = rest.match(/^\s*#\[[^\]]*\]/);
      if (!attr) break;
      from += attr[0].length;
    }
    const end = itemEnd(blanked, from);
    ranges.push([match.index, end]);
    TEST_ONLY_ATTR.lastIndex = Math.max(TEST_ONLY_ATTR.lastIndex, end);
  }
  return ranges;
}

function blankRanges(text, ranges) {
  const out = text.split("");
  for (const [from, to] of ranges) {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  }
  return out.join("");
}

/** Blanks every test-only item. Input must be blanked already. */
export function stripTestItems(blanked) {
  return blankRanges(blanked, testItemRanges(blanked));
}

/**
 * Production code of a Rust source: comments and test-only items removed, string
 * literals kept. The structure is read from a fully blanked copy so braces inside
 * strings and raw-string fixtures cannot end a test module early.
 */
export function productionSource(source) {
  const ranges = testItemRanges(blankNonCode(source));
  return blankRanges(blankNonCode(source, { keepStrings: true }), ranges);
}

/** Names referenced as `crate::<name>` (first path segment only), macros excluded. */
export function extractCrateRefs(code) {
  const refs = [];
  const grouped = /\bcrate::\{/g;
  let m;
  while ((m = grouped.exec(code)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < code.length && depth > 0) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}") depth--;
      i++;
    }
    const body = code.slice(start, i - 1);
    let level = 0;
    let current = "";
    const parts = [];
    for (const ch of body) {
      if (ch === "{") level++;
      if (ch === "}") level--;
      if (ch === "," && level === 0) {
        parts.push(current);
        current = "";
      } else current += ch;
    }
    parts.push(current);
    for (const part of parts) {
      const name = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/);
      if (name && name[1] !== "self") refs.push(name[1]);
    }
  }
  const plain = /\bcrate::([A-Za-z_][A-Za-z0-9_]*)(\s*!)?/g;
  while ((m = plain.exec(code)) !== null) {
    if (m[2]) continue; // macro invocation
    refs.push(m[1]);
  }
  return refs;
}

/** Maps names re-exported at the crate root (`pub use module::{A, B}`) to their module. */
export function rootReexports(libSource, modules) {
  const code = blankNonCode(libSource);
  const map = new Map();
  const re = /\bpub\s+use\s+([A-Za-z_][A-Za-z0-9_]*)::(\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const mod = m[1];
    if (!modules.has(mod)) continue;
    const names = m[2].startsWith("{")
      ? m[2]
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().split(/\s+as\s+/).pop())
      : [m[2]];
    for (const name of names) if (name && name !== "*") map.set(name, mod);
  }
  return map;
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name.endsWith(".rs")) files.push(full);
  }
  return files;
}

function isTestFile(relative) {
  const base = path.basename(relative);
  return base === "tests.rs" || base.endsWith("_tests.rs") || relative.split("/").includes("tests");
}

/** Top-level module of a path relative to src/ (`services/mcp.rs` -> `services`). */
export function moduleOf(relative) {
  const first = relative.split("/")[0];
  return first.endsWith(".rs") ? first.slice(0, -3) : first;
}

/**
 * Scans `srcDir` and returns the measured architecture facts:
 * edges (from -> to counts), blocking-lock uses and block_on uses per file.
 */
export function analyze(srcDir, rules) {
  const files = walk(srcDir).map((full) => ({
    full,
    relative: path.relative(srcDir, full).split(path.sep).join("/"),
  }));
  const modules = new Set(files.map((f) => moduleOf(f.relative)));
  const libPath = files.find((f) => f.relative === "lib.rs");
  const reexports = libPath ? rootReexports(fs.readFileSync(libPath.full, "utf8"), modules) : new Map();
  const edges = new Map();
  const connLocks = new Map();
  const blockOn = new Map();
  for (const file of files) {
    if (isTestFile(file.relative)) continue;
    const from = moduleOf(file.relative);
    const code = stripTestItems(blankNonCode(fs.readFileSync(file.full, "utf8")));
    for (const name of extractCrateRefs(code)) {
      const to = modules.has(name) ? name : (reexports.get(name) ?? "lib");
      if (to === from) continue;
      const key = `${from}->${to}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    if (from !== "database") {
      const n = (code.match(/\.conn\s*\.\s*lock\s*\(|\block_conn!\s*[(\[{]/g) ?? []).length;
      if (n) connLocks.set(file.relative, n);
    }
    const blocks = (code.match(/\bblock_on\s*\(/g) ?? []).length;
    if (blocks) blockOn.set(file.relative, blocks);
  }
  return { modules, edges, connLocks, blockOn, rules };
}

/** Violations of the layering rules, as `{ rule: { key: count } }`. */
export function violations(facts) {
  const { edges, rules } = facts;
  const rank = rules.ranks;
  const writers = new Set(Object.entries(rank).filter(([, r]) => r === 2).map(([m]) => m));
  const r1 = {};
  const r2 = {};
  for (const [key, count] of edges) {
    const [from, to] = key.split("->");
    if (rank[from] === undefined || rank[to] === undefined) continue;
    if (rank[from] < rank[to]) r1[key] = count;
    else if (rank[from] === 2 && rank[to] === 2) {
      const dbEdge = (from === "database") !== (to === "database");
      if (dbEdge && writers.has(from) && writers.has(to)) r2[key] = count;
    }
  }
  return {
    R1: r1,
    R2: r2,
    R4: Object.fromEntries(facts.connLocks),
    R5: Object.fromEntries(facts.blockOn),
  };
}

/** Modules found on disk that the rules file does not classify. */
export function unclassified(facts) {
  return [...facts.modules].filter((m) => facts.rules.ranks[m] === undefined).sort();
}

/** Compares measured violations with the committed baseline (a ratchet: it may only shrink). */
export function compare(measured, baseline) {
  const worse = [];
  const better = [];
  for (const rule of Object.keys(measured)) {
    const base = baseline[rule] ?? {};
    for (const [key, count] of Object.entries(measured[rule])) {
      if (base[key] === undefined) worse.push(`${rule} new: ${key} (${count})`);
      else if (count > base[key]) worse.push(`${rule} grew: ${key} ${base[key]} -> ${count}`);
      else if (count < base[key]) better.push(`${rule} shrank: ${key} ${base[key]} -> ${count}`);
    }
    for (const key of Object.keys(base)) {
      if (measured[rule][key] === undefined) better.push(`${rule} gone: ${key}`);
    }
  }
  return { worse, better };
}
