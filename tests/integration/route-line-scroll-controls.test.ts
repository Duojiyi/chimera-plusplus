import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const APP_PATH = path.resolve(__dirname, "../../src/ChimeraApp.tsx");
const CSS_PATH = path.resolve(__dirname, "../../src/chimera.css");
const appSource = fs.readFileSync(APP_PATH, "utf8");
const cssSource = fs.readFileSync(CSS_PATH, "utf8");

describe("route line overflow controls", () => {
  it("provides explicit previous and next controls alongside the native scrollbar", () => {
    expect(appSource).toContain("route-line-scroll-shell");
    expect(appSource).toContain('aria-label="显示上一条线路"');
    expect(appSource).toContain('aria-label="显示下一条线路"');
    expect(appSource).toContain("routeLineScrollRef");
  });

  it("reserves space so the controls and scrollbar cannot cover route cards", () => {
    expect(cssSource).toContain(".route-line-scroll-shell");
    expect(cssSource).toMatch(/\.route-line-scroll\s*\{[^}]*padding:\s*0 40px 8px/s);
  });
});
