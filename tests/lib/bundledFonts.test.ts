import { createHash } from "node:crypto";
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
  it("ships Overpass with the middle dot as a base glyph (see the fonts README)", () => {
    // Upstream Overpass classes U+00B7 as a mark, which renders every " · "
    // separator with zero width. A refreshed font file needs the same patch.
    const digest = createHash("sha256")
      .update(
        readFileSync(path.join(root, "src/assets/fonts/Overpass-Variable.ttf")),
      )
      .digest("hex");
    expect(digest).toBe(
      "186c0cc254888074c1d4eb9953be8c5caa26d41813087e8d7c29e552e1f37eff",
    );
  });
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
