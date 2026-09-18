import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) =>
  fs.readFileSync(path.resolve(__dirname, "../..", file), "utf8");
const globalCss = read("src/index.css");
const shellCss = read("src/chimera.css");
const native = read("src-tauri/src/lib.rs");
const config = JSON.parse(read("src-tauri/tauri.conf.json"));

describe("window corner clipping", () => {
  it("clips both portal and application surfaces to the same window radius", () => {
    expect(globalCss).toContain("--window-radius: 16px;");
    for (const selector of ["body", "#root"]) {
      const block = [
        ...globalCss.matchAll(
          new RegExp(`(?:^|\\n)${selector} \\{([^}]+)\\}`, "g"),
        ),
      ]
        .map((match) => match[1])
        .join("\n");
      expect(block).toContain("border-radius: var(--window-radius);");
      expect(block).toContain(
        "clip-path: inset(0 round var(--window-radius));",
      );
      expect(block).toMatch(/background(?:-color)?: transparent;/);
    }
    expect(shellCss).toContain("--r-xl: var(--window-radius, 16px);");
    expect(shellCss).toContain("clip-path: inset(0 round var(--r-xl));");
  });

  it("keeps the native region aligned to the viewport at any display scale", () => {
    const region = native.slice(
      native.indexOf("let scale_factor = window.scale_factor()"),
      native.indexOf("// SetWindowRgn owns"),
    );
    expect(region).toContain("32.0 * scale_factor");
    expect(region).toMatch(
      /CreateRoundRectRgn\(\s*0,\s*0,\s*size.width as i32,\s*size.height as i32,/,
    );
    expect(region).not.toContain("saturating_add(1)");
    expect(native).toContain("tauri::WindowEvent::ScaleFactorChanged");
  });

  it("keeps the native window transparent and free of rectangular decorations", () => {
    expect(
      config.app.windows.find(
        (window: { label: string }) => window.label === "main",
      ),
    ).toMatchObject({
      transparent: true,
      decorations: false,
      shadow: false,
    });
  });
});
