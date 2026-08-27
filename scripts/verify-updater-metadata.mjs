#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  console.error(
    "Usage: node scripts/verify-updater-metadata.mjs --file latest.json --tag vX.Y.Z --assets-dir release-assets [--repository owner/repo] [--config tauri.conf.json]",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
const file = valueAfter("--file");
const tag = valueAfter("--tag");
const assetsDirArg = valueAfter("--assets-dir");
const repository = valueAfter("--repository") ?? process.env.GITHUB_REPOSITORY;
const configPath = path.resolve(valueAfter("--config") ?? path.join(root, "src-tauri", "tauri.conf.json"));
if (!file || !assetsDirArg || !repository || !/^v\d+\.\d+\.\d+$/.test(tag ?? "") || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) usage();
const assetsDir = path.resolve(assetsDirArg);
const expectedVersion = tag.slice(1);
const baseUrl = `https://github.com/${repository}/releases/download/${tag}`;
const releaseUrl = `https://github.com/${repository}/releases/tag/${tag}`;
const metadata = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));

function assertUpdaterEndpointMatchesRepository() {
  const tauriConfig = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
  const endpoints = tauriConfig?.plugins?.updater?.endpoints;
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    console.error(`No plugins.updater.endpoints configured in ${configPath}`);
    process.exit(1);
  }
  const endpointPattern = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/releases\/latest\/download\/latest\.json$/;
  for (const endpoint of endpoints) {
    const match = typeof endpoint === "string" ? endpointPattern.exec(endpoint) : null;
    if (!match) {
      console.error(`Updater endpoint is not a recognized GitHub releases/latest/download URL: ${JSON.stringify(endpoint)}`);
      process.exit(1);
    }
    const endpointRepository = match[1];
    if (endpointRepository !== repository) {
      console.error(
        `Updater endpoint points at repository "${endpointRepository}" but this release is publishing to "${repository}". ` +
          `The updater endpoint in ${configPath} must match the repository CI is releasing to, or existing installs will silently ` +
          `stop receiving updates the moment the old repository name stops redirecting. Update plugins.updater.endpoints before releasing.`,
      );
      process.exit(1);
    }
  }
}

assertUpdaterEndpointMatchesRepository();

function safeBasename(value, label) {
  if (typeof value !== "string" || value.length === 0 || value !== path.basename(value) || value === "." || value === ".." || value.includes("\\")) {
    throw new Error(`${label} must be a non-empty basename`);
  }
  return value;
}
function readRegularAsset(name) {
  const filePath = path.join(assetsDir, safeBasename(name, "asset name"));
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error(`Release asset is missing or unsafe: ${name}`);
  return { bytes: fs.readFileSync(filePath), size: stat.size };
}

if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("latest.json must be an object");
if (metadata.version !== expectedVersion) throw new Error(`latest.json version ${JSON.stringify(metadata.version)} does not match ${JSON.stringify(expectedVersion)}`);
if (metadata.url !== releaseUrl) throw new Error("latest.json release URL does not exactly point to this repository tag");

const platformArtifacts = {
  "windows-x86_64": `Chimera++-${tag}-Windows.msi`,
  "windows-aarch64": `Chimera++-${tag}-Windows-arm64.msi`,
  "darwin-x86_64": `Chimera++-${tag}-macOS.tar.gz`,
  "darwin-aarch64": `Chimera++-${tag}-macOS.tar.gz`,
  "linux-x86_64": `Chimera++-${tag}-Linux-x86_64.AppImage`,
};
if (!metadata.platforms || typeof metadata.platforms !== "object" || Array.isArray(metadata.platforms)) throw new Error("latest.json has no updater platforms");
const actualPlatformNames = Object.keys(metadata.platforms).sort();
const expectedPlatformNames = Object.keys(platformArtifacts).sort();
if (JSON.stringify(actualPlatformNames) !== JSON.stringify(expectedPlatformNames)) throw new Error("latest.json updater platform set is not exact");
for (const [platform, artifact] of Object.entries(platformArtifacts)) {
  const entry = metadata.platforms[platform];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`invalid updater entry for ${platform}`);
  if (entry.url !== `${baseUrl}/${artifact}`) throw new Error(`updater URL for ${platform} is not bound to the expected release asset`);
  if (typeof entry.signature !== "string" || entry.signature.length === 0) throw new Error(`updater signature for ${platform} is missing`);
  const sig = readRegularAsset(`${artifact}.sig`).bytes.toString("utf8").trimEnd();
  if (entry.signature !== sig) throw new Error(`updater signature for ${platform} does not exactly match ${artifact}.sig`);
}

const legacyName = `ChimeraPlusPlus-${expectedVersion}-windows-x64-setup.exe`;
if (!Array.isArray(metadata.assets) || metadata.assets.length !== 1) throw new Error("latest.json must contain exactly one legacy update asset");
const legacy = metadata.assets[0];
if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) throw new Error("legacy update asset is invalid");
if (legacy.name !== legacyName || legacy.url !== `${baseUrl}/${legacyName}`) throw new Error("legacy update asset is not bound to the expected filename and URL");
if (typeof legacy.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(legacy.sha256)) throw new Error("legacy update asset SHA-256 is invalid");
if (!Number.isSafeInteger(legacy.size) || legacy.size <= 0) throw new Error("legacy update asset size is invalid");
const legacyBytes = readRegularAsset(legacyName);
const actualSha = crypto.createHash("sha256").update(legacyBytes.bytes).digest("hex");
if (legacy.sha256 !== actualSha) throw new Error(`SHA-256 mismatch for ${legacyName}`);
if (legacy.size !== legacyBytes.size) throw new Error(`size mismatch for ${legacyName}`);
console.log(`Updater metadata verified for ${tag}.`);
