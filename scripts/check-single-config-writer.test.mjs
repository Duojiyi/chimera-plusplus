import assert from "node:assert/strict";
import test from "node:test";
import { findConfigWrites } from "./check-single-config-writer.mjs";

test("allows a read-only snapshot passed to the guarded write primitive", () => {
  assert.deepEqual(
    findConfigWrites(`
fn repair() {
  let snapshot = FileSnapshot::read(get_codex_config_path())?;
  crate::codex_live_write::plan_observed_config(snapshot, &next)?.commit()?;
}`),
    [],
  );
});

for (const call of [
  'fs::write(get_codex_config_path(), "next")',
  "std::fs::remove_file(get_codex_config_path())",
  "File::create(get_codex_config_path())",
  'changeset.write(FileSnapshot::read(get_codex_config_path())?, "next")',
  'changeset.write_private(snapshot, "next")',
  "changeset.delete(snapshot)",
  "options.open(config)",
]) {
  test(`blocks direct config mutation: ${call}`, () => {
    const found = findConfigWrites(`
fn bad() {
  let config = get_codex_config_path();
  let snapshot = FileSnapshot::read(&config)?;
  ${call};
}`);
    assert.equal(found.length, 1);
    assert.equal(found[0].line, 5);
  });
}

test("ignores unrelated paths, comments, and test-only code", () => {
  assert.deepEqual(
    findConfigWrites(`
// fs::write(get_codex_config_path(), "comment")
fn other() {
  let snapshot = FileSnapshot::read(auth_path)?;
  changeset.write_private(snapshot, "auth");
}
#[cfg(test)]
mod tests {
  fn fixture() { fs::write(get_codex_config_path(), "fixture"); }
}`),
    [],
  );
});

test("path bindings do not leak into another function", () => {
  assert.deepEqual(
    findConfigWrites(`
fn read_config() { let path = get_codex_config_path(); }
fn write_auth() { let path = auth_path; fs::write(path, "auth"); }`),
    [],
  );
});

test("does not mistake backup paths or file contents for the live path", () => {
  assert.deepEqual(
    findConfigWrites(`
fn backup() {
  let config_path = get_codex_config_path();
  let text = fs::read_to_string(&config_path)?;
  let backup_path = config_path.with_extension("toml.bak");
  fs::write(&backup_path, text.as_bytes());
}`),
    [],
  );
});
