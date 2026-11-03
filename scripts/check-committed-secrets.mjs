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

// High-confidence credential shapes only. A line can opt out with the marker
// `secret-scan:allow` (for documentation that has to show a realistic shape).
const credentialPatterns = [
  { name: "private key block", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  { name: "minisign secret key", pattern: /untrusted comment: [^\n]*secret key|\bRWRTY0Iy[A-Za-z0-9+/=]{60,}/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/ },
  { name: "Anthropic API key", pattern: /\bsk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{40,}|\bsk-ant-[A-Za-z0-9_-]{60,}/ },
  { name: "OpenAI API key", pattern: /\bsk-(?:proj-|svcacct-)[A-Za-z0-9_-]{40,}|\bsk-[A-Za-z0-9]{48}\b/ },
  { name: "AWS access key id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{20,}/ },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];
// Published documentation values and this file's own pattern definitions.
const selfPath = "scripts/check-committed-secrets.mjs";
const knownExamples = new Set(["AKIAIOSFODNN7EXAMPLE"]);
const findings = [];

for (const relativePath of tracked.stdout.split("\0").filter(Boolean)) {
  if (relativePath === selfPath) continue;
  const absolutePath = path.join(root, relativePath);
  const content = readWorktreeFile(absolutePath);
  if (content === null || content.includes(0)) continue;

  const lines = content.toString("utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.includes("secret-scan:allow")) continue;
    for (const match of line.matchAll(/ctx7sk-[A-Za-z0-9-]{8,}/g)) {
      if (!allowedContext7Placeholders.has(match[0])) {
        findings.push(`${relativePath}:${index + 1} (Context7 key)`);
      }
    }
    for (const { name, pattern } of credentialPatterns) {
      const hit = pattern.exec(line);
      if (hit && !knownExamples.has(hit[0])) findings.push(`${relativePath}:${index + 1} (${name})`);
    }
  }
}

if (findings.length > 0) {
  console.error("Potential committed credentials found:");
  for (const location of findings) console.error(`- ${location}`);
  process.exit(1);
}

console.log("Committed secret check passed.");
