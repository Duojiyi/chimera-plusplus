import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const readWorkflow = (name) =>
  readFileSync(
    new URL("../.github/workflows/" + name + ".yml", import.meta.url),
    "utf8",
  );
const candidate = readWorkflow("candidate");
const release = readWorkflow("release");
const ci = readWorkflow("ci");
const portable = readWorkflow("codex-portable-validation");

test("release requires same-commit main portable validation on both Windows architectures", () => {
  assert.match(portable, /push:\s+branches:\s+- "\*\*"/);
  assert.doesNotMatch(portable, /paths:/);
  assert.match(portable, /gh api repos\/Duojiyi\/codex-app-mirror\/releases\/latest/);
  assert.match(portable, /gh release download \$release.tag_name --repo Duojiyi\/codex-app-mirror/);
  assert.match(portable, /Codex package manifest hash mismatch/);
  assert.match(release, /codex-portable-validation\.yml\/runs\?head_sha=\$tag_commit&event=push/);
  assert.match(release, /select\(\.head_sha == \$sha and \.head_branch == "main" and \.status == "completed" and \.conclusion == "success"\)/);
  assert.match(release, /for runner in windows-2022 windows-11-arm/);
  assert.match(release, /Native portable launcher \(\$runner\)/);
  assert.match(release, /Required portable validation did not pass: \$runner" >&2\s+exit 1/);
});

test("candidate checks fail at the first native command failure", () => {
  const step = candidate.match(
    /- name: Verify candidate gates\n([\s\S]*?)(?=\n      - name:)/,
  )?.[1];
  assert.match(step ?? "", /shell: bash/);
  assert.match(step ?? "", /set -euo pipefail/);
  assert.doesNotMatch(candidate, /default: "2\.4\.6"/);
});
test(
  "PowerShell evidence generation stops on failed native commands",
  { skip: process.platform !== "win32" },
  () => {
    const step = candidate.match(
      /- name: Collect candidate evidence\n([\s\S]*?)(?=\n      - name:)/,
    )?.[1];
    assert.match(
      step ?? "",
      /\$PSNativeCommandUseErrorActionPreference = \$true/,
    );
    const guard = step.match(
      /\$ErrorActionPreference = 'Stop'\s+\$PSNativeCommandUseErrorActionPreference = \$true/,
    )?.[0];
    const node = process.execPath.replaceAll("'", "''");
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        guard +
          "\n& '" +
          node +
          "' -e 'process.exit(7)'\nWrite-Output 'SHOULD_NOT_RUN'\nexit 0",
      ],
      { encoding: "utf8" },
    );
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /SHOULD_NOT_RUN/);
  },
);
test("release native Rust gates are separate steps", () => {
  assert.match(
    release,
    /name: Verify Codex relay switching[\s\S]*?run: cargo test[^\n]+\n\n      - name: Verify Codex account startup import/,
  );
});
test("latest promotion holds a shared cross-tag lock and invokes the guarded script", () => {
  const job = release.slice(release.indexOf("  assemble-latest-json:"));
  assert.match(
    job,
    /concurrency:\n      group: chimera-latest-release\n      cancel-in-progress: false/,
  );
  assert.match(job, /run: node scripts\/promote-latest-release\.mjs/);
  assert.doesNotMatch(job, /-f make_latest=true/);
});
test("CI requires JUnit output and audits development dependencies too", () => {
  assert.match(
    ci,
    /pnpm test:unit --reporter=default --reporter=junit --outputFile=test-results\/vitest.junit.xml/,
  );
  assert.match(
    ci,
    /path: test-results\/vitest.junit.xml\n          if-no-files-found: error/,
  );
  assert.match(
    ci,
    /name: Audit all npm dependencies\n        run: pnpm audit --audit-level=low/,
  );
});

test("Rust vulnerability auditing is a required CI gate", () => {
  const auditStep = ci.slice(
    ci.indexOf("      - name: Audit Rust dependencies"),
  );
  assert.match(auditStep, /run: cargo audit --file src-tauri\/Cargo.lock/);
  assert.doesNotMatch(auditStep, /continue-on-error/);
});
