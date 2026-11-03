#!/usr/bin/env node
// Prints every git-pinned package in src-tauri/Cargo.lock as a JSON array of
// { package, repository, revision }. Release evidence embeds this list as the
// build's external git dependencies.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listCargoLockGitDependencies } from "./lib/cargo-lock-revisions.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const lockIndex = args.indexOf("--lockfile");
const lockfilePath = path.resolve(lockIndex >= 0 ? args[lockIndex + 1] : path.join(root, "src-tauri", "Cargo.lock"));

try {
  const dependencies = listCargoLockGitDependencies(fs.readFileSync(lockfilePath, "utf8"));
  if (dependencies.length === 0) throw new Error(`No git dependencies found in ${lockfilePath}`);
  process.stdout.write(`${JSON.stringify(dependencies)}\n`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
