import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) =>
  fs.readFileSync(path.resolve(__dirname, "../..", file), "utf8");
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// Adapted from farion1231/cc-switch 09237ebd
describe("window drag regions", () => {
  it("keeps native app-region drag CSS to macOS", () => {
    for (const file of [
      "src/index.css",
      "src/chimera.css",
      "src/components/WindowControls.css",
    ]) {
      const selectors = [
        ...withoutComments(read(file)).matchAll(
          /([^{}]+)\{[^}]*-webkit-app-region:\s*drag\s*;[^}]*\}/g,
        ),
      ].map((match) => match[1].trim());
      // On Windows the WebView2 non-client region recomputation behind native
      // drag CSS can pin the UI thread; Tauri's drag.js handles the drag.
      expect(selectors, file).toEqual(
        file === "src/index.css" ? [".is-mac [data-tauri-drag-region]"] : [],
      );
    }
  });

  it("lets titles and icons inside a drag region start a drag", () => {
    // drag.js drags from a bare attribute only when the pressed element itself
    // carries it; "deep" covers the whole region, while buttons and inputs in
    // it still stop the drag.
    expect(read("src/lib/platform.ts")).toMatch(
      /"data-tauri-drag-region":\s*"deep"/,
    );
    // Every title-bar region goes through DRAG_REGION_ATTR, never a bare
    // attribute that would skip the platform switch.
    expect(read("src/ChimeraApp.tsx")).not.toMatch(
      /\sdata-tauri-drag-region(?=[\s>=])/,
    );
  });
});
