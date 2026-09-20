import assert from "node:assert/strict";
import test from "node:test";
import {
  compareStableTags,
  promoteLatestRelease,
} from "./promote-latest-release.mjs";

function fixture(currentTag, candidateOverrides = {}) {
  const calls = [];
  const candidate = {
    id: 42,
    tag_name: "v2.7.7",
    draft: false,
    prerelease: false,
    assets: [{ name: "latest.json", state: "uploaded", size: 100 }],
    ...candidateOverrides,
  };
  return {
    calls,
    options: {
      repository: "owner/repo",
      tag: candidate.tag_name,
      request: async (endpoint, options = {}) => {
        calls.push({ endpoint, ...options });
        if (options.method === "PATCH") return candidate;
        if (endpoint.endsWith("/latest"))
          return currentTag ? { tag_name: currentTag } : null;
        return candidate;
      },
    },
  };
}

test("compares versions numerically without overflow", () => {
  assert.equal(compareStableTags("v2.10.0", "v2.9.99"), 1);
  assert.equal(compareStableTags("v2.7.7", "v2.7.7"), 0);
  assert.equal(compareStableTags("v2.7.7", "v3.0.0"), -1);
  assert.equal(compareStableTags("v99999999999999999999.0.0", "v2.0.0"), 1);
  for (const tag of [
    "2.7.7",
    "v2.7.7-rc.1",
    "v02.7.7",
    "v2.7.7/other",
    "main",
    undefined,
  ]) {
    assert.throws(() => compareStableTags(tag, "v2.7.7"));
  }
});

for (const currentTag of ["v2.8.0", "v2.7.7"]) {
  test("does not overwrite existing latest " + currentTag, async () => {
    const { options, calls } = fixture(currentTag);
    assert.equal((await promoteLatestRelease(options)).promoted, false);
    assert.equal(calls.filter((call) => call.method === "PATCH").length, 0);
  });
}
for (const currentTag of ["v2.7.6", null]) {
  test("promotes a complete newer release from " + currentTag, async () => {
    const { options, calls } = fixture(currentTag);
    assert.equal((await promoteLatestRelease(options)).promoted, true);
    assert.deepEqual(calls.at(-1), {
      endpoint: "/repos/owner/repo/releases/42",
      method: "PATCH",
      body: { make_latest: "true" },
    });
  });
}
for (const overrides of [
  { draft: true },
  { prerelease: true },
  { id: "42" },
  { assets: [] },
  { assets: [{ name: "latest.json", state: "new", size: 100 }] },
  { assets: [{ name: "latest.json", state: "uploaded", size: 0 }] },
]) {
  test(
    "refuses incomplete or non-stable release " + JSON.stringify(overrides),
    async () => {
      const { options, calls } = fixture("v2.7.6", overrides);
      await assert.rejects(promoteLatestRelease(options));
      assert.equal(calls.filter((call) => call.method === "PATCH").length, 0);
    },
  );
}
test("fails closed on invalid current tag or API failure", async () => {
  await assert.rejects(promoteLatestRelease(fixture("unexpected-tag").options));
  const { options } = fixture("v2.7.6");
  options.request = async () => {
    throw new Error("API unavailable");
  };
  await assert.rejects(promoteLatestRelease(options), /API unavailable/);
});
test("rejects repository path injection before calling API", async () => {
  const { options, calls } = fixture("v2.7.6");
  options.repository = "owner/repo/../../other";
  await assert.rejects(promoteLatestRelease(options));
  assert.equal(calls.length, 0);
});
