import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import registry from "@/shared/tool-registry.json";
const read = (path: string) => readFileSync(path, "utf8");
describe("supported tools and layout contracts", () => {
  it("registers exactly seven tools and removes retired native modules", () => {
    expect(registry.map((t) => t.id)).toEqual([
      "codex",
      "claude",
      "claude-desktop",
      "gemini",
      "grokbuild",
      "opencode",
      "pi",
    ]);
    expect(read("src-tauri/src/tool_registry.rs")).toContain("[ToolInfo; 7]");
    for (const tool of ["openclaw", "hermes", "mcode"]) {
      expect(existsSync(`src-tauri/src/${tool}_config.rs`)).toBe(false);
      expect(read("src-tauri/src/app_config.rs")).not.toMatch(
        new RegExp(`AppType::${tool}`, "i"),
      );
    }
  });
  it("uses the current Pi npm distribution in install and version paths", () => {
    for (const path of [
      "src-tauri/src/commands/misc.rs",
      "src/components/settings/AboutSection.tsx",
    ]) {
      expect(read(path)).toContain("@earendil-works/pi-coding-agent");
      expect(read(path)).not.toContain("@mariozechner/pi-coding-agent");
    }
  });
  it("colors delete at rest and preserves the complete sidebar during maintenance", () => {
    expect(read("src/components/ProviderLineTable.css")).toMatch(
      /\.provider-row-actions \.provider-row-delete:not\(:disabled\)\s*\{\s*color:/,
    );
    expect(read("src/chimera.css")).toMatch(
      /\.runtime-maintenance-page\s*\{[^}]*inset: 40px 0 0 216px;/,
    );
    expect(read("src/views/SkillsMcpView.css")).toMatch(
      /\.resource-empty\s*\{[^}]*flex-direction: row;/,
    );
  });
});
