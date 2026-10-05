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
//   and every item guarded by `#[cfg(test)]`. Only those items are removed, so
//   production code that follows a test module in the same file is still scanned.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { productionSource } from "./lib/architecture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(root, "src-tauri", "src");
const primitive = "src-tauri/src/codex_live_write.rs";

const writeCall =
  /(?<![\w.])(?:(?:std::)?fs::(?:write|rename|copy|remove_file)|(?:crate::config::)?(?:write_text_file|write_json_file|atomic_write|atomic_write_checked|delete_file)|(?:std::fs::)?File::create)\s*\(|\.(?:write|write_private|delete|open)\s*\(/g;
const externalWriters =
  /codex_theme_engine::native::(?:apply_native_theme|apply_native_theme_value|restore_native_theme|write_snapshot_to_config|write_config_atomic)\s*\(/g;
const pathExpr =
  /get_codex_config_path\s*\(\s*\)|get_codex_config_dir\s*\(\s*\)\.(?:join|push)\(|(?:\.join|\.push)\(\s*"config\.toml"\s*\)|["'][^"']*\.codex[/\\]config\.toml["']/i;
const binding = /let\s+(?:mut\s+)?(\w+)\s*(?::[^=;]+)?=\s*([^;]*);/g;
const fnHeader =
  /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+\w+/gm;

function rustFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === "tests" ? [] : rustFiles(full);
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
  return productionSource(content);
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

// Snapshot reads are not writes. Track path/snapshot bindings so passing one
// to Changeset.write/delete still cannot bypass the live-config primitive.
export function findConfigWrites(content) {
  const text = productionText(content);
  const findings = [];
  const starts = [
    0,
    ...[...text.matchAll(fnHeader)].map((match) => match.index),
    text.length,
  ];
  for (let scope = 0; scope < starts.length - 1; scope += 1) {
    const offset = starts[scope];
    const body = text.slice(offset, starts[scope + 1]);
    const locals = new Set();
    const mentionsPath = (args) =>
      pathExpr.test(args) ||
      [...locals].some((local) =>
        new RegExp(`(?<![\\w.])${local}(?![\\w(])`).test(args),
      );
    for (const match of body.matchAll(binding)) {
      const expression = match[2].trim();
      const alias = expression.match(
        /^&?(\w+)(?:\.(?:clone|to_path_buf|to_owned)\(\))?$/,
      )?.[1];
      if (
        pathExpr.test(expression) ||
        (expression.includes("FileSnapshot::read(") &&
          mentionsPath(expression)) ||
        (alias && locals.has(alias))
      )
        locals.add(match[1]);
    }
    for (const match of body.matchAll(writeCall)) {
      const open = match.index + match[0].length - 1;
      if (mentionsPath(callArguments(body, open))) {
        findings.push({
          line: lineOf(text, offset + match.index),
          call: match[0].replace(/\s*\($/, ""),
        });
      }
    }
    for (const match of body.matchAll(externalWriters)) {
      findings.push({
        line: lineOf(text, offset + match.index),
        call: match[0].replace(/\s*\($/, ""),
      });
    }
  }
  return findings;
}

function main() {
  const findings = [];
  for (const file of rustFiles(sourceRoot)) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const name = path.basename(file);
    // Temporary isolated scratch directories do not write live config.
    if (
      relative === primitive ||
      relative === "src-tauri/src/codex_accounts/login.rs" ||
      name === "tests.rs" ||
      name.endsWith("_tests.rs")
    )
      continue;
    for (const finding of findConfigWrites(fs.readFileSync(file, "utf8"))) {
      findings.push(`${relative}:${finding.line} ${finding.call}`);
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
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main();
