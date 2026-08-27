#!/usr/bin/env node
// Prints the pinned git revision for a package declared in src-tauri/Cargo.lock,
// so release evidence generation never has to hardcode revisions that can
// silently drift out of sync with the actual locked dependency.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCargoLockRevisionFromFile } from "./lib/cargo-lock-revisions.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  console.error("Usage: node scripts/extract-cargo-lock-revision.mjs --package <name> [--lockfile <path>]");
  process.exit(2);
}

const args = process.argv.slice(2);
function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const packageName = valueAfter("--package");
if (!packageName) usage();
const lockfilePath = path.resolve(valueAfter("--lockfile") ?? path.join(root, "src-tauri", "Cargo.lock"));

try {
  const revision = readCargoLockRevisionFromFile(lockfilePath, packageName);
  process.stdout.write(`${revision}\n`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
