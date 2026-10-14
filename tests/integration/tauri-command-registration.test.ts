import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

function invokedCommands(): Set<string> {
  const names = new Set<string>();
  const pattern = /\binvoke(?:<[^>]*>)?\(\s*["']([a-z0-9_]+)["']/g;
  for (const file of sourceFiles(join(root, "src"))) {
    for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
      names.add(match[1]);
    }
  }
  return names;
}

function registeredCommands(): Set<string> {
  const lib = readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8");
  const start = lib.indexOf("generate_handler![");
  expect(start).toBeGreaterThan(-1);
  const block = lib
    .slice(start + "generate_handler![".length, lib.indexOf("])", start))
    .replace(/\/\/[^\n]*/g, "");
  // Entries are either `commands::name` or a bare `name` defined in lib.rs.
  return new Set(
    [...block.matchAll(/(?:[a-z_]+::)*([a-z][a-z0-9_]*)\s*(?:,|$)/g)].map(
      (match) => match[1],
    ),
  );
}

describe("Tauri command registration", () => {
  it("registers every command the frontend invokes", () => {
    const invoked = invokedCommands();
    // Guard against the scan silently matching nothing.
    expect(invoked.size).toBeGreaterThan(100);

    const registered = registeredCommands();
    const missing = [...invoked].filter((name) => !registered.has(name));
    expect(missing).toEqual([]);
  });
});
