#!/usr/bin/env node
import { readWorktreeFile } from "./lib/read-worktree-file.mjs";
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

const allowedContext7Placeholders = new Set([
  "ctx7sk-your-api-key-here",
  "ctx7sk-example-key",
]);
const findings = [];

for (const relativePath of tracked.stdout.split("\0").filter(Boolean)) {
  const absolutePath = path.join(root, relativePath);
  const content = readWorktreeFile(absolutePath);
  if (content === null || content.includes(0)) continue;

  const lines = content.toString("utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    for (const match of lines[index].matchAll(/ctx7sk-[A-Za-z0-9-]{8,}/g)) {
      if (!allowedContext7Placeholders.has(match[0])) {
        findings.push(`${relativePath}:${index + 1}`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error("Potential committed Context7 credentials found:");
  for (const location of findings) console.error(`- ${location}`);
  process.exit(1);
}

console.log("Committed secret check passed.");
