#!/usr/bin/env node
// Backend layering ratchet (docs/ARCHITECTURE.md).
//
//   node scripts/check-architecture.mjs            fail on any new or grown violation
//   node scripts/check-architecture.mjs --update   rewrite the baseline (do this only when it shrank)
//   node scripts/check-architecture.mjs --matrix   print the module dependency matrix
//
// The baseline records the violations that already existed when the rules were
// introduced. It may only shrink: a new violation, or a larger count for an
// existing one, fails the check.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyze,
  baselineFromRef,
  compare,
  parseBaseline,
  unclassified,
  violations,
} from "./lib/architecture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src-tauri", "src");
const rulesPath = path.join(root, "scripts", "architecture-rules.json");
const baselinePath = path.join(root, "scripts", "architecture-baseline.json");

try {
  const args = new Set();
  let baselineRef;
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (
      arg === "--baseline-ref" &&
      baselineRef === undefined &&
      argv[index + 1] &&
      !argv[index + 1].startsWith("--")
    ) {
      baselineRef = argv[++index];
    } else if (["--update", "--matrix"].includes(arg) && !args.has(arg)) {
      args.add(arg);
    } else {
      throw new Error(
        "Usage: check-architecture.mjs [--update] [--baseline-ref <trusted-git-ref>] | --matrix",
      );
    }
  }
  if (
    args.has("--matrix") &&
    (args.has("--update") || baselineRef !== undefined)
  ) {
    throw new Error(
      "--matrix cannot be combined with baseline verification or update.",
    );
  }
  const rules = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
  const facts = analyze(srcDir, rules);

  const missing = unclassified(facts);
  if (missing.length) {
    console.error(
      "Modules without a layer rank (add them to scripts/architecture-rules.json):",
    );
    for (const name of missing) console.error(`- ${name}`);
    process.exit(1);
  }

  const measured = violations(facts);

  if (args.has("--matrix")) {
    const mods = Object.keys(rules.ranks).filter((m) => facts.modules.has(m));
    const width = Math.max(...mods.map((m) => m.length));
    for (const from of mods) {
      const cells = mods
        .filter((to) => facts.edges.has(`${from}->${to}`))
        .map((to) => `${to}:${facts.edges.get(`${from}->${to}`)}`);
      console.log(
        `${from.padEnd(width)} (${rules.ranks[from]}) -> ${cells.join(" ")}`,
      );
    }
    process.exit(0);
  }

  const trusted =
    baselineRef === undefined ? null : baselineFromRef(root, baselineRef);
  const baseline = fs.existsSync(baselinePath)
    ? parseBaseline(fs.readFileSync(baselinePath, "utf8"))
    : args.has("--update") && trusted;
  if (!baseline) {
    throw new Error(
      "Architecture baseline is missing; restore the approved baseline or use --update --baseline-ref <approved-ref>.",
    );
  }
  if (trusted) {
    const { worse } = compare(baseline, trusted);
    if (worse.length) {
      throw new Error(
        `Architecture baseline grew beyond trusted ref ${baselineRef}:\n${worse.join("\n")}`,
      );
    }
  }
  const { worse, better } = compare(measured, baseline);
  if (worse.length) {
    throw new Error(
      `Backend layering violations beyond the baseline:\n${worse.join("\n")}`,
    );
  }

  if (args.has("--update")) {
    const sorted = Object.fromEntries(
      Object.entries(measured).map(([rule, entries]) => [
        rule,
        Object.fromEntries(
          Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)),
        ),
      ]),
    );
    fs.writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
    const total = Object.values(sorted).reduce(
      (n, entries) => n + Object.keys(entries).length,
      0,
    );
    console.log(`Baseline written: ${total} entries.`);
    process.exit(0);
  }

  for (const line of better) console.log(`improved: ${line}`);
  if (better.length) {
    console.log(
      "The baseline can shrink: run `node scripts/check-architecture.mjs --update` and commit it.",
    );
  }
  console.log("Backend layering check passed.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
