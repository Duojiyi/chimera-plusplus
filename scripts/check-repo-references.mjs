#!/usr/bin/env node
// The repository was renamed from Duojiyi/chimera-codex to Duojiyi/chimera-plusplus.
// GitHub keeps a redirect alive for the old name, which is exactly why stale
// references never break and silently accumulate. Release provenance, Cargo git
// sources, README badges and the in-app About links must all agree on the new
// name, so this check fails CI when the old name reappears in tracked files.
// Historical documents (CHANGELOG, docs/) legitimately keep the old name.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const legacyRepositories = ["Duojiyi/chimera-codex", "farion1231/cc-switch"];
const historicalPathPrefixes = ["CHANGELOG.md", "docs/"];

const tracked = spawnSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
});
if (tracked.status !== 0) {
  throw new Error(tracked.stderr.trim() || "git ls-files failed");
}

const findings = [];
for (const relativePath of tracked.stdout.split("\0").filter(Boolean)) {
  const normalized = relativePath.replace(/\\/g, "/");
  if (historicalPathPrefixes.some((prefix) => normalized.startsWith(prefix))) continue;
  if (normalized === "scripts/check-repo-references.mjs") continue;

  const content = fs.readFileSync(path.join(root, relativePath));
  if (content.includes(0)) continue;

  const lines = content.toString("utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (legacyRepositories.some((repository) => lines[index].includes(repository))) {
      findings.push(`${relativePath}:${index + 1}`);
    }
  }
}

if (findings.length > 0) {
  console.error(`Stale references to retired repositories found:`);
  for (const location of findings) console.error(`- ${location}`);
  process.exit(1);
}

console.log("Repository reference check passed.");
