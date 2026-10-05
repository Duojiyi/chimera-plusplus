#!/usr/bin/env node
// Provider presets are product data, not an ad slot (PRODUCT.md): no partner
// flags and no affiliate, invite or referral links. This check fails CI when
// any of those markers reappears in the frontend preset config or the Rust
// sources, so a preset sync from upstream cannot quietly bring them back.
import { readWorktreeFile } from "./lib/read-worktree-file.mjs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scannedPrefixes = ["src/config/", "src-tauri/src/"];

// `ref=` is also how git refs are passed to GitHub; only a `ref=` query
// parameter on a non-GitHub URL counts as a referral code.
const gitRefHosts = /^(?:[a-z0-9-]+\.)*(?:github\.com|githubusercontent\.com)$/i;
const referralRef = (line) =>
  [...line.matchAll(/https?:\/\/([^/\s"'`?#]+)[^\s"'`]*[?&]ref=/gi)].some(
    (match) => !gitRefHosts.test(match[1]),
  );

const rules = [
  { name: "aff=", test: (line) => /\baff=/i.test(line) },
  { name: "invitecode", test: (line) => /invitecode/i.test(line) },
  { name: "isPartner: true", test: (line) => /\bisPartner\s*:\s*true\b/.test(line) },
  { name: "referral ref=", test: referralRef },
];

const tracked = spawnSync("git", ["ls-files", "-z", "--", ...scannedPrefixes], {
  cwd: root,
  encoding: "utf8",
});
if (tracked.status !== 0) {
  throw new Error(tracked.stderr.trim() || "git ls-files failed");
}

const findings = [];
for (const relativePath of tracked.stdout.split("\0").filter(Boolean)) {
  const content = readWorktreeFile(path.join(root, relativePath));
  if (content === null || content.includes(0)) continue;

  const lines = content.toString("utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const rule of rules) {
      if (rule.test(line)) findings.push(`${relativePath}:${index + 1} (${rule.name})`);
    }
  });
}

if (findings.length > 0) {
  console.error("Partner or referral markers found in provider preset data:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("Preset promotion check passed.");
