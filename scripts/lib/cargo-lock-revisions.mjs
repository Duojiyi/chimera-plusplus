// Shared helper for reading pinned git revisions out of a Cargo.lock file.
//
// Cargo.lock entries for git dependencies look like:
//
//   [[package]]
//   name = "chimera-runtime"
//   version = "1.2.42-chimera.1"
//   source = "git+https://github.com/Duojiyi/chimera-codex.git?rev=<sha>#<sha>"
//   dependencies = [...]
//
// We deliberately avoid pulling in a full TOML parser dependency: Cargo.lock
// is a machine-generated, highly regular format, and splitting on `[[package]]`
// boundaries is a well-established, low-risk way to extract this information
// without adding a new dependency (and the extra `pnpm install` / lockfile
// churn that would require).
import fs from "node:fs";

/**
 * Extract the pinned 40-character git revision for `packageName` from the
 * text of a Cargo.lock file. Throws if the package is missing, has no git
 * source, or (defensively) has multiple differing revisions.
 */
export function readCargoLockRevision(lockfileText, packageName) {
  const blocks = lockfileText.split(/\r?\n(?=\[\[package\]\])/);
  const revisions = new Set();
  let found = false;
  for (const block of blocks) {
    const nameMatch = /^\[\[package\]\]\r?\nname = "([^"]+)"/.exec(block);
    if (!nameMatch || nameMatch[1] !== packageName) continue;
    found = true;
    const sourceMatch = /\r?\nsource = "([^"]+)"/.exec(block);
    if (!sourceMatch) continue;
    const revMatch = /[?&]rev=([0-9a-f]{40})(?:[&#]|$)/.exec(sourceMatch[1]);
    if (revMatch) revisions.add(revMatch[1]);
  }
  if (!found) {
    throw new Error(`Package not found in Cargo.lock: ${packageName}`);
  }
  if (revisions.size === 0) {
    throw new Error(`Package ${packageName} in Cargo.lock has no pinned git revision (source is not a git+...#<sha> URL)`);
  }
  if (revisions.size > 1) {
    throw new Error(`Package ${packageName} has multiple differing git revisions in Cargo.lock: ${[...revisions].join(", ")}`);
  }
  return [...revisions][0];
}

/** Same as {@link readCargoLockRevision}, but reads the lockfile from disk. */
export function readCargoLockRevisionFromFile(lockfilePath, packageName) {
  return readCargoLockRevision(fs.readFileSync(lockfilePath, "utf8"), packageName);
}
