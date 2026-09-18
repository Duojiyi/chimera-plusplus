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
    for (const css of [usage, shell]) {
      const rows: string[] = [];
      css.walkRules((rule) => {
        if (
          [".chimera-main", ".chimera-main.is-usage-view"].includes(
            rule.selector,
          )
        ) {
          rule.walkDecls("grid-template-rows", (decl) => {
            rows.push(decl.value);
          });
        }
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows)
        expect(row).toContain("var(--shell-nav-row-height)");
    }
  });
});

describe("usage viewport layout", () => {
  it("reserves room for the ranking by allowing the desktop chart to shrink", () => {
    const declarations: Record<string, Record<string, string>> = {};
    usage.walkAtRules("media", (media) => {
      if (media.params !== "(min-width: 901px)") return;
      media.walkRules((rule) => {
        const values: Record<string, string> = {};
        rule.walkDecls((decl) => {
          values[decl.prop] = decl.value;
        });
        declarations[rule.selector] = values;
      });
    });
    expect(declarations[".usage-surface.usage-spectrum"]).toMatchObject({
      height: "100%",
      display: "flex",
      "flex-direction": "column",
    });
    expect(declarations[".usage-spectrum-panel"]).toMatchObject({
      flex: "1",
      "min-height": "min-content",
      "grid-template-rows": "auto minmax(180px, 1fr) auto",
    });
    expect(declarations[".usage-spectrum-trend"]).toMatchObject({
      height: "auto",
      "min-height": "180px",
    });
  });
});
