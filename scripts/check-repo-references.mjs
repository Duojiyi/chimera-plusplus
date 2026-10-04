#!/usr/bin/env node
// The repository was renamed from Duojiyi/chimera-codex to Duojiyi/chimera-plusplus.
// GitHub keeps a redirect alive for the old name, which is exactly why stale
// references never break and silently accumulate. Release provenance, Cargo git
// sources, README badges and the in-app About links must all agree on the new
// name, so this check fails CI when the old name reappears in tracked files.
// Historical documents (CHANGELOG, docs/) legitimately keep the old name.
//
// Separately, farion1231/cc-switch is the *upstream* project Chimera++ forked
// from (MIT). Correctly crediting it is required, not stale — so attribution
// files are allowed to name it (MH-10), while the old maintainer's personal
// handle/email have no legitimate reason to appear anywhere going forward and
// get no such allowance (MH-1).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const legacyRepositories = ["Duojiyi/chimera-codex", "farion1231/cc-switch"];
const legacyContacts = ["@farion1231", "farion1231@gmail.com"];
const historicalPathPrefixes = ["CHANGELOG.md", "docs/"];
// MH-10: files whose entire purpose is to correctly attribute upstream code
// may name farion1231/cc-switch as its source without being flagged as a
// stale self-reference. This does not extend to legacyContacts.
const attributionPathPrefixes = [
  "THIRD_PARTY_NOTICES.md",
  "LICENSES/",
  // Shipped with the vendored AGPL crates; credits the upstream project.
  "src-tauri/crates/NOTICE",
];
const attributionLineMarkers = ["Adapted from", "改写自", "移植自"];

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

  const isAttributionFile = attributionPathPrefixes.some((prefix) => normalized.startsWith(prefix));
  const lines = content.toString("utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const repositoryHit = legacyRepositories.some((repository) => line.includes(repository));
    if (repositoryHit) {
      const isAttributionLine = isAttributionFile || attributionLineMarkers.some((marker) => line.includes(marker));
      if (!isAttributionLine) findings.push(`${relativePath}:${index + 1}`);
    }

    if (legacyContacts.some((contact) => line.includes(contact))) {
      findings.push(`${relativePath}:${index + 1}`);
    }
  }
}

if (findings.length > 0) {
  console.error(`Stale references to the retired repository or its former maintainer found:`);
  for (const location of findings) console.error(`- ${location}`);
  process.exit(1);
}

console.log("Repository reference check passed.");
