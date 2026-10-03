import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const readCss = (file: string) =>
  postcss.parse(
    fs.readFileSync(path.resolve(__dirname, "../..", file), "utf8"),
  );
const usage = readCss("src/views/UsageView.css");
const shell = readCss("src/chimera.css");

describe("shared bottom navigation", () => {
  it("does not restyle the global navigation on the usage page", () => {
    usage.walkRules((rule) => {
      expect(rule.selector).not.toContain(".route-bottom-nav");
    });
  });

  it("uses the same footer row height on normal and short windows", () => {
    const heights: string[] = [];
    shell.walkDecls("--shell-nav-row-height", (decl) => {
      heights.push(decl.value);
    });
    expect(heights).toEqual(["150px", "126px"]);
    expect(usage.toString()).toContain(".is-usage-view .chimera-content");
    expect(shell.toString()).toContain("var(--shell-nav-row-height)");
  });
});

describe("usage viewport layout", () => {
  it("keeps the chart and ranking side by side on wide screens", () => {
    const rule = usage.nodes.find(
      (node) =>
        node.type === "rule" && node.selector === ".usage-analysis-grid",
    );
    expect(rule?.toString()).toContain("minmax(278px, 0.52fr)");
    const compactColumns: string[] = [];
    usage.walkAtRules("media", (media) => {
      media.walkRules(".usage-analysis-grid", (grid) => {
        grid.walkDecls("grid-template-columns", (decl) => {
          compactColumns.push(decl.value);
        });
      });
    });
    expect(compactColumns).toContain("1fr");
  });
});
