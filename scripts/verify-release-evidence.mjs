#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCargoLockRevisionFromFile } from "./lib/cargo-lock-revisions.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  console.error(
    "Usage: node scripts/verify-release-evidence.mjs --assets-dir <dir> --tag vX.Y.Z --commit <40-hex-sha> [--cargo-lock <path>]",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const assetsDirArg = valueAfter("--assets-dir");
const tag = valueAfter("--tag");
const commit = valueAfter("--commit");
if (!assetsDirArg || !tag || !commit || !/^v\d+\.\d+\.\d+$/.test(tag) || !/^[0-9a-f]{40}$/.test(commit)) usage();
const assetsDir = path.resolve(assetsDirArg);
if (!fs.statSync(assetsDir).isDirectory()) throw new Error(`Assets path is not a directory: ${assetsDir}`);
const cargoLockPath = path.resolve(valueAfter("--cargo-lock") ?? path.join(root, "src-tauri", "Cargo.lock"));

function safeBasename(value, label) {
  if (typeof value !== "string" || value.length === 0 || value !== path.basename(value) || value === "." || value === ".." || value.includes("\\")) {
    throw new Error(`${label} must be a non-empty basename`);
  }
  return value;
}

function assetPath(name) {
  return path.join(assetsDir, safeBasename(name, "asset name"));
}

function readRegularFile(name) {
  const file = assetPath(name);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error(`Missing regular release asset: ${name}`);
  return fs.readFileSync(file);
}

function sha256(name) {
  return crypto.createHash("sha256").update(readRegularFile(name)).digest("hex");
}

function parseJsonAsset(name) {
  try {
    return JSON.parse(readRegularFile(name).toString("utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Invalid JSON in ${name}: ${error.message}`);
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function assertExactString(value, expected, label) {
  if (value !== expected) throw new Error(`${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`);
}

function verifyExternalGitDependencies(value, name, lockfilePath) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name}.externalGitDependencies must be a non-empty array`);
  const identities = new Set();
  for (const dependency of value) {
    assertObject(dependency, `${name}.externalGitDependencies entry`);
    if (typeof dependency.package !== "string" || !dependency.package) throw new Error(`${name}.externalGitDependencies package is invalid`);
    if (typeof dependency.repository !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(dependency.repository)) {
      throw new Error(`${name}.externalGitDependencies repository is invalid`);
    }
    if (typeof dependency.revision !== "string" || !/^[0-9a-f]{40}$/.test(dependency.revision)) {
      throw new Error(`${name}.externalGitDependencies revision is not a pinned 40-character SHA`);
    }
    const identity = `${dependency.package}\u0000${dependency.repository}`;
    if (identities.has(identity)) throw new Error(`${name}.externalGitDependencies has duplicate package/repository entries`);
    identities.add(identity);

    // Cross-check the declared provenance revision against what is actually
    // locked in Cargo.lock, so a stale/hand-edited provenance entry cannot
    // silently misrepresent the supply chain (this previously only checked
    // that `revision` looked like a SHA, not that it was the *right* SHA).
    let lockedRevision;
    try {
      lockedRevision = readCargoLockRevisionFromFile(lockfilePath, dependency.package);
    } catch (error) {
      throw new Error(`${name}.externalGitDependencies entry for ${dependency.package} could not be cross-checked against ${lockfilePath}: ${error.message}`);
    }
    if (lockedRevision !== dependency.revision) {
      throw new Error(
        `${name}.externalGitDependencies revision for ${dependency.package} (${dependency.revision}) does not match the revision actually locked in Cargo.lock (${lockedRevision})`,
      );
    }
  }
}

const platformSpecs = [
  {
    platform: "windows-x86_64",
    target: "x86_64-pc-windows-msvc",
    updater: `Chimera++-${tag}-Windows.msi`,
    required: [
      `Chimera++-${tag}-Windows.msi`,
      `Chimera++-${tag}-Windows.msi.sig`,
      `Chimera++-${tag}-Windows-Portable.zip`,
      `ChimeraPlusPlus-${tag.slice(1)}-windows-x64-setup.exe`,
      "frontend-sbom-windows-x86_64.json",
      "rust-sbom-windows-x86_64.json",
      "build-provenance-windows-x86_64.json",
      "codex-mirror-provenance-windows-x86_64.json",
    ],
  },
  {
    platform: "windows-arm64",
    target: "aarch64-pc-windows-msvc",
    updater: `Chimera++-${tag}-Windows-arm64.msi`,
    required: [
      `Chimera++-${tag}-Windows-arm64.msi`,
      `Chimera++-${tag}-Windows-arm64.msi.sig`,
      `Chimera++-${tag}-Windows-arm64-Portable.zip`,
      "frontend-sbom-windows-arm64.json",
      "rust-sbom-windows-arm64.json",
      "build-provenance-windows-arm64.json",
      "codex-mirror-provenance-windows-arm64.json",
    ],
  },
  {
    platform: "macos-universal",
    target: "universal-apple-darwin",
    updater: `Chimera++-${tag}-macOS.tar.gz`,
    required: [
      `Chimera++-${tag}-macOS.tar.gz`,
      `Chimera++-${tag}-macOS.tar.gz.sig`,
      `Chimera++-${tag}-macOS.zip`,
      `Chimera++-${tag}-macOS.dmg`,
      "frontend-sbom-macos-universal.json",
      "rust-sbom-macos-universal.json",
      "build-provenance-macos-universal.json",
    ],
  },
  {
    platform: "linux-x86_64",
    target: "x86_64-unknown-linux-gnu",
    updater: `Chimera++-${tag}-Linux-x86_64.AppImage`,
    required: [
      `Chimera++-${tag}-Linux-x86_64.AppImage`,
      `Chimera++-${tag}-Linux-x86_64.AppImage.sig`,
      `Chimera++-${tag}-Linux-x86_64.deb`,
      `Chimera++-${tag}-Linux-x86_64.rpm`,
      "frontend-sbom-linux-x86_64.json",
      "rust-sbom-linux-x86_64.json",
      "build-provenance-linux-x86_64.json",
    ],
  },
];

function verifyChecksumManifest(spec) {
  const name = `SHA256SUMS-${spec.platform}.txt`;
  const text = readRegularFile(name).toString("utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error(`${name} is empty`);
  const entries = new Map();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([^\s]+)$/.exec(line);
    if (!match) throw new Error(`${name} has malformed checksum line: ${JSON.stringify(line)}`);
    const [, expectedHash, asset] = match;
    safeBasename(asset, `${name} entry`);
    if (entries.has(asset)) throw new Error(`${name} has duplicate entry: ${asset}`);
    entries.set(asset, expectedHash);
    const actualHash = sha256(asset);
    if (actualHash !== expectedHash) throw new Error(`${name} SHA-256 mismatch for ${asset}`);
  }
  for (const required of spec.required) {
    if (!entries.has(required)) throw new Error(`${name} does not cover required release evidence: ${required}`);
  }
}

function verifyMirrorProvenance(platform, provenance) {
  const name = `codex-mirror-provenance-${platform}.json`;
  const mirror = parseJsonAsset(name);
  assertObject(mirror, name);
  if (mirror.schemaVersion !== 1) throw new Error(`${name}.schemaVersion must be 1`);
  for (const key of ["repository", "tag", "commit", "asset", "sha256"]) {
    if (typeof mirror[key] !== "string" || mirror[key].length === 0) throw new Error(`${name}.${key} must be a non-empty string`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(mirror.repository)) {
    throw new Error(`${name}.repository is invalid`);
  }
  if (!/^[0-9a-f]{40}$/.test(mirror.commit)) throw new Error(`${name}.commit is not a pinned 40-character SHA`);
  if (!/^[0-9a-f]{64}$/.test(mirror.sha256)) throw new Error(`${name}.sha256 is invalid`);
  safeBasename(mirror.asset, `${name}.asset`);
  if (!provenance.codexMirror || JSON.stringify(provenance.codexMirror) !== JSON.stringify(mirror)) {
    throw new Error(`${name} does not exactly match build provenance codexMirror`);
  }
}

for (const spec of platformSpecs) {
  for (const name of spec.required) readRegularFile(name);
  verifyChecksumManifest(spec);
  const provenanceName = `build-provenance-${spec.platform}.json`;
  const provenance = parseJsonAsset(provenanceName);
  assertObject(provenance, provenanceName);
  if (provenance.schemaVersion !== 1) throw new Error(`${provenanceName}.schemaVersion must be 1`);
  assertExactString(provenance.releaseTag, tag, `${provenanceName}.releaseTag`);
  assertExactString(provenance.sourceCommit, commit, `${provenanceName}.sourceCommit`);
  assertExactString(provenance.platform, spec.platform, `${provenanceName}.platform`);
  assertExactString(provenance.target, spec.target, `${provenanceName}.target`);
  assertObject(provenance.runner, `${provenanceName}.runner`);
  for (const key of ["name", "os", "arch"]) {
    if (typeof provenance.runner[key] !== "string" || !provenance.runner[key]) throw new Error(`${provenanceName}.runner.${key} is invalid`);
  }
  verifyExternalGitDependencies(provenance.externalGitDependencies, provenanceName, cargoLockPath);
  if (spec.platform.startsWith("windows-")) verifyMirrorProvenance(spec.platform, provenance);
}

console.log(`Verified release evidence for ${tag} at ${commit}.`);
