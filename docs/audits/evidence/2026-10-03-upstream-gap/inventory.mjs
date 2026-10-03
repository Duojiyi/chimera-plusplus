import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const sourceRoot = path.join(root, "src");
const relative = (filename) =>
  path.relative(root, filename).replaceAll("\\", "/");
const modules = new Map();
function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(filename);
    else if (
      /\.(tsx?|jsx?)$/.test(filename) &&
      !/\.(test|spec)\./.test(filename)
    ) {
      const source = fs.readFileSync(filename, "utf8");
      const ast = ts.createSourceFile(
        filename,
        source,
        ts.ScriptTarget.Latest,
        true,
      );
      const dependencies = [];
      const calls = [];
      function walk(node) {
        if (
          (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) ||
          (ts.isExportDeclaration(node) && !node.isTypeOnly)
        ) {
          if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
            dependencies.push(node.moduleSpecifier.text);
        }
        if (ts.isCallExpression(node)) {
          const first = node.arguments[0];
          if (
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            first &&
            ts.isStringLiteral(first)
          )
            dependencies.push(first.text);
          if (
            ts.isIdentifier(node.expression) &&
            node.expression.text === "invoke" &&
            first
          ) {
            calls.push({
              command: ts.isStringLiteral(first) ? first.text : null,
              expression: first.getText(ast),
              file: relative(filename),
              line:
                ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
            });
          }
        }
        ts.forEachChild(node, walk);
      }
      walk(ast);
      modules.set(filename, { dependencies, calls });
    }
  }
}
collect(sourceRoot);
function resolveModule(filename, specifier) {
  const base = specifier.startsWith("@/")
    ? path.join(sourceRoot, specifier.slice(2))
    : specifier.startsWith(".")
      ? path.resolve(path.dirname(filename), specifier)
      : null;
  if (!base) return null;
  return [
    base,
    ...[".ts", ".tsx", ".js", ".jsx"].map((extension) => base + extension),
    ...["index.ts", "index.tsx", "index.js"].map((entry) =>
      path.join(base, entry),
    ),
  ].find((candidate) => modules.has(candidate));
}
const reachable = new Set();
function visit(filename) {
  if (reachable.has(filename) || !modules.has(filename)) return;
  reachable.add(filename);
  for (const specifier of modules.get(filename).dependencies) {
    const next = resolveModule(filename, specifier);
    if (next) visit(next);
  }
}
visit(path.join(sourceRoot, "main.tsx"));
const rust = fs.readFileSync(path.join(root, "src-tauri/src/lib.rs"), "utf8");
const block = rust.match(/generate_handler!\[([\s\S]*?)\]\)/)?.[1];
if (!block) throw new Error("No Tauri command registration found");
const registered = [...block.matchAll(/^\s*([\w:]+),\s*$/gm)].map((match) =>
  match[1].split("::").at(-1),
);
const registeredSet = new Set(registered);
const allCalls = [...modules.values()].flatMap((module) => module.calls);
const reachableCalls = [...reachable].flatMap(
  (filename) => modules.get(filename).calls,
);
const invoked = new Set(
  reachableCalls.map((call) => call.command).filter(Boolean),
);
const targets = [
  "src/components/AppSwitcher.tsx",
  "src/components/providers/ProviderList.tsx",
  "src/components/providers/forms/ClaudeDesktopProviderForm.tsx",
  "src/components/proxy/ClaudeDesktopRouteToggle.tsx",
  "src/components/profiles/ProfileSwitcher.tsx",
  "src/components/skills/UnifiedSkillsPanel.tsx",
  "src/components/mcp/UnifiedMcpPanel.tsx",
  "src/views/SettingsView.tsx",
];
console.log(
  JSON.stringify(
    {
      method:
        "Conservative literal-module import graph from src/main.tsx, including dynamic imports and barrel exports. Reachability is an upper bound, not proof of a reachable UI control. Calls named invoke only; tests excluded. The unregistered-command check excludes plugin commands. Dynamic command names and non-literal module paths require manual review. No native commands executed.",
      sourceModules: modules.size,
      reachableModules: reachable.size,
      registeredCommands: registered.length,
      literalInvocations: allCalls.filter((call) => call.command).length,
      uniqueReachableInvocations: invoked.size,
      targetReachability: targets.map((filename) => ({
        file: filename,
        reachable: reachable.has(path.join(root, filename)),
      })),
      unregisteredLiteralInvocations: allCalls.filter(
        (call) =>
          call.command &&
          !call.command.includes(":") &&
          !registeredSet.has(call.command),
      ),
      registeredWithoutReachableLiteralInvocation: registered.filter(
        (command) => !invoked.has(command),
      ),
      dynamicInvocations: reachableCalls.filter((call) => !call.command),
      claudeDesktopInvocations: allCalls
        .filter((call) => call.command?.includes("claude_desktop"))
        .map((call) => ({
          ...call,
          moduleReachable: reachable.has(path.join(root, call.file)),
        })),
    },
    null,
    2,
  ),
);
