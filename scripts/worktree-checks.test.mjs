import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readWorktreeFile } from "./lib/read-worktree-file.mjs";

const scripts = fileURLToPath(new URL(".", import.meta.url));
const checks = [
  ["check-repo-references.mjs", "Duojiyi/" + "chimera-codex"],
  ["check-preset-promotion.mjs", "isPartner: " + "true"],
  ["check-committed-secrets.mjs", "ctx7sk-" + "regression-fixture"],
];

for (const [script, forbidden] of checks) {
  test(
    script + " skips deleted tracked files without skipping violations",
    (context) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "chimera-check-"));
      context.after(() => fs.rmSync(root, { recursive: true, force: true }));
      fs.mkdirSync(path.join(root, "scripts/lib"), { recursive: true });
      fs.mkdirSync(path.join(root, "src/config"), { recursive: true });
      fs.copyFileSync(
        path.join(scripts, script),
        path.join(root, "scripts", script),
      );
      fs.copyFileSync(
        path.join(scripts, "lib/read-worktree-file.mjs"),
        path.join(root, "scripts/lib/read-worktree-file.mjs"),
      );
      const deleted = path.join(root, "src/config/deleted file.ts");
      const retained = path.join(root, "src/config/retained.ts");
      fs.writeFileSync(deleted, "safe");
      fs.writeFileSync(retained, "safe");
      for (const args of [
        ["init", "--quiet"],
        ["add", "src"],
      ]) {
        const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      }
      fs.unlinkSync(deleted);
      const run = () =>
        spawnSync(process.execPath, [path.join(root, "scripts", script)], {
          cwd: root,
          encoding: "utf8",
        });
      const clean = run();
      assert.equal(clean.status, 0, clean.stderr);
      fs.writeFileSync(retained, forbidden);
      const dirty = run();
      assert.equal(dirty.status, 1, dirty.stderr);
      assert.ok(
        dirty.stderr.includes("src/config/retained.ts:1"),
        dirty.stderr,
      );
    },
  );
}

test("readWorktreeFile preserves binary data and propagates non-missing errors", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chimera-read-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "binary");
  const bytes = Buffer.from([0, 255, 65]);
  fs.writeFileSync(file, bytes);
  assert.deepEqual(readWorktreeFile(file), bytes);
  assert.equal(readWorktreeFile(path.join(root, "missing")), null);
  assert.throws(() => readWorktreeFile(null), { code: "ERR_INVALID_ARG_TYPE" });
});

test("check-committed-secrets.mjs recognises common credential shapes and honours opt-outs", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chimera-secrets-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts/lib"), { recursive: true });
  for (const file of ["check-committed-secrets.mjs", "lib/read-worktree-file.mjs"]) {
    fs.copyFileSync(path.join(scripts, file), path.join(root, "scripts", file));
  }
  // Shapes are assembled at runtime so this file never contains one itself.
  const shapes = {
    "private key block": "-----BEGIN " + "RSA PRIVATE KEY-----",
    "minisign secret key": "untrusted " + "comment: rsign encrypted secret" + " key",
    "GitHub token": "gh" + "p_" + "a1B2".repeat(9),
    "Anthropic API key": "sk-" + "ant-api03-" + "Ab1_".repeat(12),
    "OpenAI API key": "sk-" + "proj-" + "Ab1_".repeat(12),
    "AWS access key id": "AK" + "IA" + "ABCDEFGHIJKLMNOP",
    "Slack token": "xox" + "b-" + "1234567890-abcdefghij",
    "Google API key": "AI" + "za" + "A".repeat(35),
  };
  const git = (...args) => assert.equal(spawnSync("git", args, { cwd: root, encoding: "utf8" }).status, 0);
  const run = () =>
    spawnSync(process.execPath, [path.join(root, "scripts/check-committed-secrets.mjs")], { cwd: root, encoding: "utf8" });
  git("init", "--quiet");
  for (const [name, value] of Object.entries(shapes)) {
    fs.writeFileSync(path.join(root, "leak.txt"), `token = ${value}\n`);
    git("add", "leak.txt");
    const found = run();
    assert.equal(found.status, 1, `${name} must be rejected`);
    assert.ok(found.stderr.includes(`leak.txt:1 (${name})`), found.stderr);
  }
  fs.writeFileSync(path.join(root, "leak.txt"), `token = ${shapes["GitHub token"]} # secret-scan:allow\n`);
  assert.equal(run().status, 0, "an explicit opt-out marker is honoured");
  fs.writeFileSync(path.join(root, "leak.txt"), "key = sk-your-key-here and AKIA" + "IOSFODNN7EXAMPLE\n");
  assert.equal(run().status, 0, "placeholders and the published AWS example key are not credentials");
});
