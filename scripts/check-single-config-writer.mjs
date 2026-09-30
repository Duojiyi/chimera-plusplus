#!/usr/bin/env node
// Every write of Codex's live config.toml goes through one primitive,
// `src-tauri/src/codex_live_write.rs`, which runs the instruction-file gate
// (`validate_instruction_refs`) and commits through a CAS changeset (plan
// lane L5, R3A-N17). This check fails CI when any other Rust source writes,
// deletes or renames that file directly.
//
// Heuristics (source-level, no compiler):
// - a "Codex config path" is `get_codex_config_path()`, a
//   `<codex…>.join("config.toml")`, or a local bound to either within the
//   same function;
// - a direct write is a file-writing call whose arguments mention one;
// - handing the path to a known external writer (the theme engine's
//   config-writing functions) counts as a direct write too;
// - test code is skipped: `tests.rs`, `*_tests.rs`, `tests/` directories,
//   and everything from a top-level `#[cfg(test)] mod … {` to the end of
//   the file (where this codebase keeps its test modules).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(root, "src-tauri", "src");
const primitive = "src-tauri/src/codex_live_write.rs";

const writeCall =
  /(?<![\w.])(?:(?:std::)?fs::(?:write|rename|copy|remove_file)|(?:crate::config::)?(?:write_text_file|write_json_file|atomic_write|atomic_write_checked|delete_file)|(?:std::fs::)?File::create|FileSnapshot::read|\.open)\s*\(/g;
const externalWriters =
  /codex_theme_engine::native::(?:apply_native_theme|apply_native_theme_value|restore_native_theme|write_snapshot_to_config|write_config_atomic)\s*\(/g;
const pathExpr = /get_codex_config_path\s*\(\s*\)|get_codex_config_dir\s*\(\s*\)\.(?:join|push)\(|(?:\.join|\.push)\(\s*"config\.toml"\s*\)|["'][^"']*\.codex[/\\]config\.toml["']/i;
const binding = /let\s+(?:mut\s+)?(\w+)\s*(?::[^=;]+)?=\s*([^;]*);/g;
const fnHeader = /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+\w+/gm;
const testModule = /^#\[cfg\(test\)\]\s*\r?\n(?:#\[[^\n]*\]\s*\r?\n)*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{/m;

function rustFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "tests" ? [] : rustFiles(full);
    return entry.name.endsWith(".rs") ? [full] : [];
  });
}

// Arguments of the call whose opening parenthesis is at `open`.
function callArguments(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return text.slice(open + 1, index);
  }
  return text.slice(open + 1);
}

function productionText(content) {
  const cut = content.search(testModule);
  const text = cut === -1 ? content : content.slice(0, cut);
  // Drop whole-line comments (doc comments quote paths and calls).
  return text
    .split(/\r?\n/)
    .map((line) => (line.trimStart().startsWith("//") ? "" : line))
    .join("\n");
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

const findings = [];
for (const file of rustFiles(sourceRoot)) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  const name = path.basename(file);
  if (relative === primitive || name === "tests.rs" || name.endsWith("_tests.rs")) continue;

  const text = productionText(fs.readFileSync(file, "utf8"));
  const starts = [0, ...[...text.matchAll(fnHeader)].map((match) => match.index), text.length];
  for (let scope = 0; scope < starts.length - 1; scope += 1) {
    const offset = starts[scope];
    const body = text.slice(offset, starts[scope + 1]);
    const locals = [...body.matchAll(binding)]
      .filter((match) => pathExpr.test(match[2]))
      .map((match) => match[1]);
    const mentionsPath = (args) =>
      pathExpr.test(args) ||
      locals.some((local) => new RegExp(`(?<![\\w.])${local}(?![\\w(])`).test(args));

    for (const match of body.matchAll(writeCall)) {
      const open = match.index + match[0].length - 1;
      if (mentionsPath(callArguments(body, open))) {
        findings.push(`${relative}:${lineOf(text, offset + match.index)} ${match[0].replace(/\s*\($/, "")}`);
      }
    }
    for (const match of body.matchAll(externalWriters)) {
      findings.push(`${relative}:${lineOf(text, offset + match.index)} ${match[0].replace(/\s*\($/, "")}`);
    }
  }
}

if (findings.length > 0) {
  console.error(
    `Direct writes of Codex config.toml outside ${primitive} (use codex_live_write instead):`,
  );
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("Single Codex config writer check passed.");
