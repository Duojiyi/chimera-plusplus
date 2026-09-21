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
const codexPin = JSON.parse(
  readFileSync(new URL("../.github/codex-portable-pin.json", import.meta.url), "utf8"),
);

test("release requires same-commit main portable validation on both Windows architectures", () => {
  assert.match(portable, /push:\s+branches:\s+- "\*\*"/);
  assert.doesNotMatch(portable, /paths:/);
  assert.match(portable, /\.github\/codex-portable-pin\.json/);
  assert.match(portable, /releases\/tags\/\$\(\$pin\.tag\)/);
  assert.match(portable, /Codex package pin or manifest hash mismatch/);
  assert.match(release, /codex-portable-validation\.yml\/runs\?head_sha=\$tag_commit&event=push/);
  assert.match(release, /select\(\.head_sha == \$sha and \.head_branch == "main" and \.status == "completed" and \.conclusion == "success"\)/);
  assert.match(release, /for runner in windows-2022 windows-11-arm/);
  assert.match(release, /Native portable launcher \(\$runner\)/);
  assert.match(release, /Required portable validation did not pass: \$runner" >&2\s+exit 1/);
});

test("release and portable CI share immutable package identity and checksums", () => {
  assert.equal(codexPin.schemaVersion, 1);
  assert.match(codexPin.tag, /^codex-app-\d+\.\d+\.\d+$/);
  assert.match(codexPin.commit, /^[0-9a-f]{40}$/);
  for (const architecture of ["x64", "arm64"]) {
    const asset = codexPin.assets[architecture];
    assert.match(asset.name, new RegExp(`^OpenAI\\.Codex_[\\d.]+_${architecture}__\\w+\\.Msix$`));
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
  }
  for (const workflow of [release, portable]) {
    assert.match(workflow, /Get-Content -LiteralPath '\.github\/codex-portable-pin\.json' -Raw/);
    assert.doesNotMatch(workflow, /Expand-Archive/);
    assert.ok(!workflow.includes(codexPin.tag));
    assert.ok(!workflow.includes(codexPin.commit));
    assert.match(workflow, /Get-FileHash.*SHA256/);
  }
  assert.doesNotMatch(portable, /releases\/latest/);
  assert.match(release, /repos\/\$codexMirrorRepository\/releases\/tags\/\$codexMirrorTag/);
  assert.match(release, /\$mirrorCommitResponse.sha -ne \$codexMirrorCommit/);
  assert.match(release, /\$packageArch = if \(\$isArm64\) \{ 'arm64' \} else \{ 'x64' \}/);
  assert.match(release, /\$msixAsset = \$codexPin.assets.\$packageArch/);
  assert.match(release, /\$actualHash -ne \$msixAsset.sha256/);
  assert.match(portable, /\$commit.sha -ne \$pin.commit/);
  assert.match(portable, /\$asset = \$pin.assets.\(\$env:PACKAGE_ARCH\)/);
  assert.match(portable, /\$expectedHash -ne \$asset.sha256 -or \$actualHash -ne \$asset.sha256/);
});

test("portable packaging uses the locked engine, native launcher and real module resolution", () => {
  assert.match(release, /cargo metadata --locked.*src-tauri\/Cargo.toml/);
  assert.match(release, /Where-Object name -eq 'codex-win-engine'/);
  assert.match(release, /signature.is_valid_openai\(\)/);
  assert.match(release, /install_portable_from_msix_with_observer\(\s+msix, root, false, false, &mut \|_\| Ok\(\(\)\)/);
  assert.match(release, /root.join\("LaunchCodex.exe"\).is_file\(\)/);
  assert.match(release, /root.join\("codex-portable-launcher.txt"\).is_file\(\)/);
  assert.match(release, /require.resolve\('@oai\/sky'/);
  assert.match(release, /require.resolve\('@statsig\/client-core'/);
  assert.match(release, /cargo run --locked --manifest-path \$engineManifest --example chimera_package/);
  assert.match(release, /if \(\$LASTEXITCODE -ne 0\) \{ throw 'Codex engine packaging failed' \}/);
  assert.match(release, /finally \{\s+Remove-Item -LiteralPath \$helper -Force/);
});

test("modified workflow PowerShell blocks parse without executing commands", { skip: process.platform !== "win32" }, () => {
  for (const workflow of [release, portable]) {
    for (const step of workflow.split(/\n      - /).filter((step) => step.includes("shell: pwsh") && step.includes("run: |"))) {
      const body = step.split("run: |\n")[1].match(/^(?:          .*\n|\n)*/)[0];
      const script = body.replace(/^          /gm, "");
      const encoded = Buffer.from(script).toString("base64");
      const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
        `$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors); if ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }`,
      ], { encoding: "utf8" });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
    }
  }
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
