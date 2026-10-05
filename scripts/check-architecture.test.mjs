import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

import {
  blankNonCode,
  compare,
  extractCrateRefs,
  moduleOf,
  parseBaseline,
  rootReexports,
  stripTestItems,
  violations,
} from "./lib/architecture.mjs";

const prod = (source) => stripTestItems(blankNonCode(source));
const refs = (source) => extractCrateRefs(prod(source));

test("references inside comments and string literals are ignored", () => {
  const source = `
    // use crate::services::x;
    /* crate::proxy::y /* nested crate::commands::z */ still comment */
    fn f() {
        let s = "crate::database::nope";
        let raw = r#"crate::mcp::nope { not a block"#;
        let real = crate::config::path();
    }
  `;
  assert.deepEqual(refs(source), ["config"]);
});

test("char literals and lifetimes do not derail the scanner", () => {
  const source = `
    fn f<'a>(x: &'a str) -> char { let c = '{'; let q = '\\''; crate::error::E; c }
  `;
  assert.deepEqual(refs(source), ["error"]);
});

test("grouped use declarations yield each top-level module once per item", () => {
  const source = `use crate::{app_config::AppType, config::{read, write}, error::AppError, self};`;
  assert.deepEqual(refs(source), ["app_config", "config", "error"]);
});

test("a path followed by a brace group keeps the whole module name", () => {
  assert.deepEqual(refs("use crate::config::{read, write};"), ["config"]);
  assert.deepEqual(refs("use crate::database::dao::{a, b};"), ["database"]);
});

test("macro invocations are not module references", () => {
  assert.deepEqual(refs("fn f() { crate::lock_conn!(db); crate::settings::get(); }"), ["settings"]);
});

test("cfg(test) modules, functions and uses are dropped, other cfgs are kept", () => {
  const source = `
    use crate::config::a;
    #[cfg(test)]
    use crate::services::only_in_tests;
    #[cfg(any(windows, test))]
    use crate::process_utils::kept_in_production;
    #[cfg(test)]
    mod tests {
        use crate::proxy::p;
        fn braces() { let s = "}"; }
        #[test] fn t() { crate::commands::c(); }
    }
    fn after() { crate::settings::s(); }
  `;
  assert.deepEqual(refs(source).sort(), ["config", "process_utils", "settings"]);
});

test("a cfg(test) item stops at its own end, including a trailing semicolon", () => {
  const source = `
    #[cfg(test)]
    static FIXTURE: Fixture = Fixture { a: crate::proxy::p };
    fn kept() { crate::mcp::m(); }
  `;
  assert.deepEqual(refs(source), ["mcp"]);
});

test("path-attribute test modules declared with a semicolon are dropped", () => {
  const source = `
    #[cfg(test)]
    #[path = "x_tests.rs"]
    mod tests;
    fn kept() { crate::config::c(); }
  `;
  assert.deepEqual(refs(source), ["config"]);
});

test("root re-exports resolve names that are not modules", () => {
  const lib = `
    pub use store::AppState;
    pub use services::{A, B as Renamed};
    pub use config::read_json_file;
  `;
  const map = rootReexports(lib, new Set(["store", "services", "config"]));
  assert.equal(map.get("AppState"), "store");
  assert.equal(map.get("Renamed"), "services");
  assert.equal(map.get("A"), "services");
  assert.equal(map.get("read_json_file"), "config");
});

test("moduleOf maps files and directories to their top-level module", () => {
  assert.equal(moduleOf("lib.rs"), "lib");
  assert.equal(moduleOf("config.rs"), "config");
  assert.equal(moduleOf("services/mcp.rs"), "services");
});

test("only upward edges and database/writer cross edges are violations", () => {
  const rules = {
    ranks: { commands: 5, services: 4, config: 0, database: 2, codex_config: 2, mcp: 2, settings: 1 },
  };
  const facts = {
    rules,
    edges: new Map([
      ["commands->services", 10], // downward: fine
      ["config->settings", 2], // upward: violation
      ["database->codex_config", 5], // peer rank across the database/writer boundary
      ["mcp->codex_config", 3], // writers may use each other
      ["unknown->config", 1], // unclassified modules are reported elsewhere
    ]),
    connLocks: new Map(),
    blockOn: new Map(),
  };
  const found = violations(facts);
  assert.deepEqual(found.R1, { "config->settings": 2 });
  assert.deepEqual(found.R2, { "database->codex_config": 5 });
});

test("the ratchet fails on new or grown violations and notes improvements", () => {
  const baseline = { R1: { "a->b": 3, "c->d": 2 }, R2: {}, R4: {}, R5: { "x.rs": 4 } };
  const measured = { R1: { "a->b": 4, "e->f": 1 }, R2: {}, R4: {}, R5: { "x.rs": 3 } };
  const { worse, better } = compare(measured, baseline);
  assert.deepEqual(worse, ["R1 grew: a->b 3 -> 4", "R1 new: e->f (1)"]);
  assert.deepEqual(better, ["R1 gone: c->d", "R5 shrank: x.rs 4 -> 3"]);
});

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselineFile = "scripts/architecture-baseline.json";
const fixtureBaseline = (count) => ({
  R1: count ? { "config->services": count } : {}, R2: {}, R4: {}, R5: {},
});

function architectureFixture(context, count = 1, baseline = fixtureBaseline(count)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chimera-architecture-"));
  context.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("chimera-architecture-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const write = (file, text) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  for (const file of ["scripts/check-architecture.mjs", "scripts/lib/architecture.mjs"]) {
    write(file, fs.readFileSync(path.join(repository, file)));
  }
  write("scripts/architecture-rules.json", JSON.stringify({ ranks: { config: 0, services: 4 } }));
  write("src-tauri/src/services.rs", "pub fn work() {}\n");
  const source = (value) => write("src-tauri/src/config.rs", `fn work() { ${"crate::services::work();".repeat(value)} }\n`);
  source(count);
  if (baseline !== null) write(baselineFile, JSON.stringify(baseline));
  write("empty-gitconfig", "");
  const git = (...args) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, "empty-gitconfig"), GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
  git("init", "--quiet", "--template=");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "-m", "Trusted fixture");
  const trusted = git("rev-parse", "HEAD");
  const read = () => fs.readFileSync(path.join(root, baselineFile), "utf8");
  const run = (...args) => {
    const result = spawnSync(process.execPath, ["scripts/check-architecture.mjs", ...args], { cwd: root, encoding: "utf8" });
    assert.ifError(result.error);
    return result;
  };
  return { root, write, source, trusted, read, run };
}

test("update rejects new violations and count increases without rewriting the baseline", (context) => {
  for (const initial of [0, 1]) {
    const fixture = architectureFixture(context, initial);
    const before = fixture.read();
    fixture.source(initial + 1);
    const result = fixture.run("--update");
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /R1 (new|grew): config->services/);
    assert.equal(fixture.read(), before);
  }
});

test("update permits unchanged and decreased counts, including removing violations", (context) => {
  const fixture = architectureFixture(context, 2);
  for (const count of [2, 1, 0]) {
    fixture.source(count);
    const result = fixture.run("--update", "--baseline-ref", fixture.trusted);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fixture.read()), fixtureBaseline(count));
  }
});

test("trusted ref rejects an added or raised allowance even when local source matches it", (context) => {
  for (const initial of [0, 1]) {
    const fixture = architectureFixture(context, initial);
    fixture.source(initial + 1);
    fixture.write(baselineFile, JSON.stringify(fixtureBaseline(initial + 1)));
    assert.equal(fixture.run().status, 0);
    const before = fixture.read();
    for (const flags of [[], ["--update"]]) {
      const result = fixture.run(...flags, "--baseline-ref", fixture.trusted);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /baseline grew beyond trusted ref/);
      assert.equal(fixture.read(), before);
    }
  }
});

test("trusted ref permits a reduced committed baseline and still checks source", (context) => {
  const fixture = architectureFixture(context, 2);
  fixture.write(baselineFile, JSON.stringify(fixtureBaseline(1)));
  fixture.source(1);
  assert.equal(fixture.run("--baseline-ref", fixture.trusted).status, 0);
  fixture.source(2);
  const result = fixture.run("--baseline-ref", fixture.trusted);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /R1 grew: config->services 1 -> 2/);
});

test("a new baseline cannot be bootstrapped from unapproved local source or a ref without a baseline", (context) => {
  const fixture = architectureFixture(context, 1, null);
  assert.equal(fixture.run("--update").status, 1);
  assert.equal(fs.existsSync(path.join(fixture.root, baselineFile)), false);
  fixture.write(baselineFile, JSON.stringify(fixtureBaseline(1)));
  const result = fixture.run("--baseline-ref", fixture.trusted);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot read a valid architecture baseline from trusted ref/);
});

test("a missing local baseline can be restored only within a trusted allowance", (context) => {
  const fixture = architectureFixture(context, 1);
  fs.unlinkSync(path.join(fixture.root, baselineFile));
  fixture.source(2);
  assert.equal(fixture.run("--update", "--baseline-ref", fixture.trusted).status, 1);
  assert.equal(fs.existsSync(path.join(fixture.root, baselineFile)), false);
  fixture.source(1);
  const result = fixture.run("--update", "--baseline-ref", fixture.trusted);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fixture.read()), fixtureBaseline(1));
});

test("invalid refs and CLI options fail closed without updating", (context) => {
  const fixture = architectureFixture(context);
  const before = fixture.read();
  for (const args of [
    ["--baseline-ref", "missing-ref"], ["--baseline-ref"], ["--unknown"],
    ["--matrix", "--baseline-ref", fixture.trusted], ["--matrix", "--update"],
  ]) {
    assert.equal(fixture.run(...args).status, 1, args.join(" "));
    assert.equal(fixture.read(), before);
  }
});

test("malformed local and trusted baseline counts cannot disable the ratchet", (context) => {
  for (const count of [null, "999", -1, 1.5]) {
    const malformed = fixtureBaseline(count);
    malformed.R1["config->services"] = count;
    assert.throws(() => parseBaseline(JSON.stringify(malformed)), /Invalid architecture baseline/);
  }
  for (const text of ["null", "[]", "{}", "{", JSON.stringify({ ...fixtureBaseline(1), R9: {} })]) {
    assert.throws(() => parseBaseline(text));
  }
  const fixture = architectureFixture(context, 1, { ...fixtureBaseline(1), R1: { "config->services": "999" } });
  const before = fixture.read();
  assert.equal(fixture.run("--update").status, 1);
  assert.equal(fixture.read(), before);
  fixture.write(baselineFile, JSON.stringify(fixtureBaseline(1)));
  assert.equal(fixture.run("--baseline-ref", fixture.trusted).status, 1);
});

test("CI and every candidate platform compare against a trusted ref with history available", () => {
  const ci = fs.readFileSync(path.join(repository, ".github/workflows/ci.yml"), "utf8");
  const candidate = fs.readFileSync(path.join(repository, ".github/workflows/candidate.yml"), "utf8");
  assert.match(ci, /github\.event\.pull_request\.base\.sha \|\| github\.event\.before \|\| 'origin\/main'/);
  assert.match(ci, /fetch-depth: 0/);
  assert.match(ci, /git cat-file -e.*\|\| git fetch --no-tags origin/);
  assert.match(ci, /node scripts\/check-architecture\.mjs --baseline-ref "\$ARCHITECTURE_BASE_REF"/);
  assert.equal((candidate.match(/fetch-depth: 0/g) ?? []).length, 3);
  assert.equal((candidate.match(/node scripts\/check-architecture\.mjs --baseline-ref origin\/main/g) ?? []).length, 3);
});
