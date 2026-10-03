import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const css = readFileSync(path.join(root, "src/theme/fonts.css"), "utf8");

describe("offline design fonts", () => {
  for (const [family, filename, license] of [
    ["Overpass", "Overpass-Variable.ttf", "Overpass"],
    ["Overpass Mono", "OverpassMono-Variable.ttf", "OverpassMono"],
    ["Noto Sans SC", "NotoSansSC-Variable.woff2", "NotoSansSC"],
  ]) {
    it(`bundles ${family} with its license and a local font face`, () => {
      expect(css).toContain(`font-family: "${family}"`);
      expect(css).toContain(`../assets/fonts/${filename}`);
      expect(existsSync(path.join(root, "src/assets/fonts", filename))).toBe(
        true,
      );
      expect(
        readFileSync(
          path.join(root, "src/public/licenses", `${license}-OFL.txt`),
          "utf8",
        ),
      ).toContain("SIL OPEN FONT LICENSE");
    });
  }
  it("uses WOFF2 for the complete CJK font without a system-font shortcut or CDN", () => {
    expect(
      readFileSync(
        path.join(root, "src/assets/fonts/NotoSansSC-Variable.woff2"),
      )
        .subarray(0, 4)
        .toString(),
    ).toBe("wOF2");
    expect(css).not.toMatch(/https?:|local\(/);
    expect(readFileSync(path.join(root, "src/index.html"), "utf8")).not.toMatch(
      /fonts\.(?:googleapis|gstatic)\.com/,
    );
    expect(css).toContain("font-weight: 100 900");
  });
});
