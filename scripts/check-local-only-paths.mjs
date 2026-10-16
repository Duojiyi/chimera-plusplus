#!/usr/bin/env node
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tracked = spawnSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
});

if (tracked.status !== 0) {
  throw new Error(tracked.stderr.trim() || "git ls-files failed");
}

// Paths that belong to the maintainer's local workspace and must not be tracked.
// Each entry is a literal prefix (relative to repo root) or an exact path.
const localOnlyPatterns = [
  "assets/首页图片.png",
  "designs/chimera-user-guide.html",
  // Add more as needed. Glob patterns are not supported; use exact prefixes.
];

const findings = [];

for (const relativePath of tracked.stdout.split("\0").filter(Boolean)) {
  for (const pattern of localOnlyPatterns) {
    if (relativePath === pattern || relativePath.startsWith(pattern + "/")) {
      findings.push(relativePath);
    }
  }
}

if (findings.length > 0) {
  console.error("Local-only files found in tracked tree:");
  for (const location of findings) console.error(`- ${location}`);
  console.error(
    "\nThese files belong to the maintainer's workspace and must not be committed."
  );
  process.exit(1);
}

console.log("Local-only path check passed.");
