#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

export function compareStableTags(left, right) {
  const parse = (tag) => {
    if (
      typeof tag !== "string" ||
      !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)
    ) {
      throw new Error(
        "Latest promotion requires stable vMAJOR.MINOR.PATCH tags",
      );
    }
    return tag.slice(1).split(".").map(BigInt);
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

// The workflow must hold its cross-tag concurrency lock throughout this call.
export async function promoteLatestRelease({ repository, tag, request }) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
    repository.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("A valid GitHub owner/repository is required");
  }
  compareStableTags(tag, tag);
  const base = "/repos/" + repository + "/releases";
  const candidate = await request(base + "/tags/" + tag);
  if (
    !Number.isSafeInteger(candidate?.id) ||
    candidate.id <= 0 ||
    candidate.tag_name !== tag ||
    candidate.draft !== false ||
    candidate.prerelease !== false
  ) {
    throw new Error(
      "The candidate is not a published stable release for the requested tag",
    );
  }
  const metadata = candidate.assets?.filter(
    (asset) => asset.name === "latest.json",
  );
  if (
    metadata?.length !== 1 ||
    metadata[0].state !== "uploaded" ||
    !(metadata[0].size > 0)
  ) {
    throw new Error("The candidate has no complete latest.json asset");
  }
  const current = await request(base + "/latest", { allowNotFound: true });
  if (current && compareStableTags(tag, current.tag_name) <= 0) {
    return { promoted: false, tag, currentTag: current.tag_name };
  }
  await request(base + "/" + candidate.id, {
    method: "PATCH",
    body: { make_latest: "true" },
  });
  return { promoted: true, tag, currentTag: current?.tag_name ?? null };
}

async function main() {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("GH_TOKEN is required");
  const request = async (
    endpoint,
    { method = "GET", body, allowNotFound = false } = {},
  ) => {
    const response = await fetch("https://api.github.com" + endpoint, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "chimera-release-promotion",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok)
      throw new Error("GitHub release API failed: HTTP " + response.status);
    return response.json();
  };
  const result = await promoteLatestRelease({
    repository: process.env.GITHUB_REPOSITORY,
    tag: process.env.GITHUB_REF_NAME,
    request,
  });
  console.log(
    result.promoted
      ? "Promoted " + result.tag + " to latest"
      : "Kept " +
          result.currentTag +
          " as latest; " +
          result.tag +
          " is not newer",
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
