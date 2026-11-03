import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { listCargoLockGitDependencies, readCargoLockRevision } from "./lib/cargo-lock-revisions.mjs";

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

test("CI and every candidate platform enforce backend layering", () => {
  assert.match(ci, /^          node scripts\/check-architecture\.mjs --baseline-ref "\$ARCHITECTURE_BASE_REF"$/m);
  assert.match(ci, /node --test [^\n]*scripts\/check-architecture\.test\.mjs/);
  const gates = [...candidate.matchAll(/- name: Verify candidate gates\n([\s\S]*?)(?=\n      - name:)/g)];
  assert.equal(gates.length, 3);
  for (const [, gate] of gates) {
    assert.match(gate, /node scripts\/check-architecture\.mjs --baseline-ref origin\/main/);
    assert.match(gate, /^          node scripts\/verify-release-version\.mjs/m);
    assert.match(gate, /^          node scripts\/check-architecture\.mjs/m);
  }
});

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
  // Engine v0.5.16 keeps the official payload in app\ (nested layout).
  assert.match(release, /root.join\("Codex.exe"\).is_file\(\) && root.join\("app"\).is_dir\(\)/);
  assert.match(release, /root.join\("app\/resources\/cua_node\/bin"\)/);
  assert.doesNotMatch(release, /root.join\("resources\/cua_node\/bin"\)/);
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

const stepNames = (workflow) => [...workflow.matchAll(/^      - name: (.+)$/gm)].map((match) => match[1]);

test("candidate only receives the signing key for main or release-tagged commits", () => {
  const jobs = candidate.split(/^  (?=windows:|macos:|linux:)/m).slice(1);
  assert.equal(jobs.length, 3);
  for (const job of jobs) {
    const names = stepNames(job);
    const trust = names.indexOf("Verify candidate source is trusted");
    const install = names.indexOf("Install frontend dependencies");
    const prepare = names.indexOf("Prepare Tauri signing key");
    assert.ok(trust >= 0, "every candidate job verifies where the commit comes from");
    // The check runs before any step that executes code from the requested ref.
    assert.ok(trust < install && install < prepare);
    assert.match(job, /git merge-base --is-ancestor "\$SOURCE_COMMIT" origin\/main/);
    assert.match(job, /git tag --points-at "\$SOURCE_COMMIT"/);
  }
});

test("the updater key is scrubbed from the job right after the build that signs", () => {
  const candidateJobs = candidate.split(/^  (?=windows:|macos:|linux:)/m).slice(1);
  const releaseJob = release.slice(release.indexOf("\n  release:\n"), release.indexOf("\n  publish-release:\n"));
  for (const [workflowJob, build, firstEvidence] of [
    [candidateJobs[0], /^Build Windows candidate$/, "Collect candidate evidence"],
    [candidateJobs[1], /^Build universal macOS candidate$/, "Collect candidate evidence"],
    [candidateJobs[2], /^Build Linux candidate$/, "Smoke test Linux packages"],
    [releaseJob, /^Build Tauri App \(Linux\)$/, "Prepare macOS Assets"],
  ]) {
    const names = stepNames(workflowJob);
    const built = names.findIndex((name) => build.test(name));
    const scrub = names.indexOf("Scrub Tauri signing key");
    assert.ok(built >= 0 && scrub === built + 1, "scrub directly follows the last signing build");
    assert.ok(scrub < names.indexOf(firstEvidence));
  }
  for (const workflow of [candidate, release]) {
    const scrub = workflow.match(/- name: Scrub Tauri signing key\n([\s\S]*?)(?=\n      - name:)/)?.[1] ?? "";
    assert.match(scrub, /if: always\(\)/);
    assert.match(scrub, /rm -f "\$\{RUNNER_TEMP:-\$\{TMPDIR:-\/tmp\}\}\/tauri_signing\.key"/);
    assert.match(scrub, /TAURI_SIGNING_PRIVATE_KEY=%s\\nTAURI_SIGNING_PRIVATE_KEY_PASSWORD=%s\\n' '' '' >> "\$GITHUB_ENV"/);
  }
});

test("the AGPL notice names the exact commit Cargo.lock builds", () => {
  const notices = readFileSync(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
  const lock = readFileSync(new URL("../src-tauri/Cargo.lock", import.meta.url), "utf8");
  const noticed = /pinned to commit\s+`([0-9a-f]{40})`/.exec(notices)?.[1];
  assert.ok(noticed, "THIRD_PARTY_NOTICES.md names the pinned commit");
  for (const crate of ["chimera-runtime", "chimera-platform", "chimera-domain"]) {
    assert.equal(readCargoLockRevision(lock, crate), noticed, `${crate} is built from the noticed commit`);
  }
  for (const source of ["realiti4/claude-swap", "Nemo-Illusionist/claude-code-account-switcher", "openai/codex"]) {
    assert.ok(notices.includes(source), `${source} adapted code is acknowledged`);
  }
});

test("every distribution carries the AGPL text, the notices and a source offer", () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  assert.match(read("LICENSE-AGPL-3.0"), /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3, 19 November 2007/);
  assert.match(read("LICENSE"), /^MIT License/);
  const bundle = JSON.parse(read("src-tauri/tauri.conf.json")).bundle;
  assert.deepEqual(bundle.resources, {
    "../LICENSE": "licenses/LICENSE-MIT.txt",
    "../LICENSE-AGPL-3.0": "licenses/LICENSE-AGPL-3.0.txt",
    "../THIRD_PARTY_NOTICES.md": "licenses/THIRD_PARTY_NOTICES.md",
  });
  // Source licence metadata matches the AGPL notice instead of claiming plain MIT.
  assert.equal(JSON.parse(read("package.json")).license, "MIT AND AGPL-3.0-only");
  assert.match(read("src-tauri/Cargo.toml"), /^license = "MIT AND AGPL-3\.0-only"$/m);
  // The in-app source offer points at the commit Cargo.lock builds.
  const offered = /AGPL_SOURCE_COMMIT = "([0-9a-f]{40})"/.exec(read("src/lib/licenses.ts"))?.[1];
  assert.equal(offered, readCargoLockRevision(read("src-tauri/Cargo.lock"), "chimera-runtime"));
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

test("an in-app update can never restart the machine", () => {
  const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const wix = readFileSync(new URL("../src-tauri/wix/per-user-main.wxs", import.meta.url), "utf8");
  assert.match(wix, /<Property Id="REBOOT" Value="ReallySuppress"\s*\/>/);
  assert.match(release, /if \(\$reboot -ne 'ReallySuppress'\) \{ throw/);
});

test("the app, its runtime crate and the release share one Codex engine revision", () => {
  const manifest = readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
  const lock = readFileSync(new URL("../src-tauri/Cargo.lock", import.meta.url), "utf8");
  const tables = new Map();
  let table = "";
  for (const line of manifest.split(/\r?\n/)) {
    const header = /^\[([^\]]+)\]\s*$/.exec(line);
    if (header) table = header[1];
    else tables.set(table, `${tables.get(table) ?? ""}${line}\n`);
  }
  const pinned = (name, tableName) => {
    const match = new RegExp(String.raw`^${name} = \{[^\n]*\bgit = "([^"]+)"[^\n]*\brev = "([0-9a-f]{40})"`, "m").exec(
      tables.get(tableName) ?? "",
    );
    return match ? { git: match[1], rev: match[2] } : undefined;
  };
  const engine = pinned("codex-win-engine", "dependencies");
  assert.ok(engine, "codex-win-engine must be pinned to a full revision");
  // chimera-runtime brings its own engine pin; the [patch] may only route it
  // to the app's own engine source and revision, never to a third one.
  const patched = pinned("codex-win-engine", 'patch."https://github.com/Wangnov/Codex-App-Manager.git"');
  if (patched !== undefined) assert.deepEqual(patched, engine);
  const engines = lock
    .split(/\r?\n(?=\[\[package\]\])/)
    .filter((block) => /^\[\[package\]\]\r?\nname = "codex-win-engine"\r?\n/.test(block));
  assert.equal(engines.length, 1, "Cargo.lock must hold exactly one Windows engine");
  assert.equal(readCargoLockRevision(lock, "codex-win-engine"), engine.rev);
  const source = /\nsource = "([^"]+)"/.exec(engines[0])[1];
  assert.equal(source, `git+${engine.git}?rev=${engine.rev}#${engine.rev}`);
  // Both engines come from one upstream revision, and the release provenance
  // names the repository they are actually built from.
  assert.deepEqual(pinned("codex-theme-engine", "dependencies"), engine);
  // The release provenance is generated from Cargo.lock on every platform, so
  // it names the repository the engines are actually built from.
  const listed = listCargoLockGitDependencies(lock);
  for (const name of ["codex-win-engine", "codex-theme-engine"]) {
    assert.equal(listed.find((dependency) => dependency.package === name)?.repository, engine.git);
  }
});

test("release provenance lists every git dependency locked in Cargo.lock", () => {
  const lock = readFileSync(new URL("../src-tauri/Cargo.lock", import.meta.url), "utf8");
  const locked = (lock.match(/^source = "git\+/gm) ?? []).length;
  const listed = listCargoLockGitDependencies(lock);
  assert.equal(listed.length, locked, "every git source in Cargo.lock is listed");
  for (const name of ["chimera-domain", "chimera-platform", "chimera-runtime", "codex-archive", "codex-theme-engine", "codex-win-engine"]) {
    assert.ok(listed.some((dependency) => dependency.package === name), `${name} is part of the provenance`);
  }
  assert.equal(release.split("node scripts/list-cargo-lock-git-dependencies.mjs").length - 1, 3);
  assert.doesNotMatch(release, /extract-cargo-lock-revision/);
  const verifier = readFileSync(new URL("./verify-release-evidence.mjs", import.meta.url), "utf8");
  assert.match(verifier, /is missing Cargo\.lock git packages/);
});
