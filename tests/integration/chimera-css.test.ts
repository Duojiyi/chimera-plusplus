/**
 * Integration test — Bug 3: CSS scrollbar fix + update banner styles.
 *
 * Reads src/chimera.css directly and asserts:
 *  - .route-line-scroll exposes a compact native scrollbar when overflow exists
 *  - the scrollbar is allocated below the cards instead of being hidden/overlaid
 *  - .route-line-card keeps a readable minimum width so the fourth route remains reachable
 *  - .route-update-banner block is present (Bug 2 styles)
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const CSS_PATH = path.resolve(__dirname, "../../src/chimera.css");
const css = fs.readFileSync(CSS_PATH, "utf8");

// ---------------------------------------------------------------------------
// Helper: extract the text of the FIRST CSS block whose selector matches
// ---------------------------------------------------------------------------
function extractBlock(selector: string): string {
  // Escape selector for regex use
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s");
  const match = re.exec(css);
  return match ? match[1] : "";
}

describe("chimera.css — Bug 3 scrollbar fix", () => {
  it(".route-line-scroll exposes a thin native scrollbar", () => {
    const block = extractBlock(".route-line-scroll");
    expect(block).toContain("scrollbar-width: thin");
    expect(block).not.toContain("scrollbar-width: none");
  });

  it(".route-line-scroll reserves room for the scrollbar below route cards", () => {
    const block = extractBlock(".route-line-scroll");
    expect(block).toMatch(/scrollbar-gutter:\s*stable/);
  });

  it(".route-line-scroll does not suppress the native scrollbar", () => {
    const block = extractBlock(".route-line-scroll");
    expect(block).not.toContain("-ms-overflow-style: none");
  });

  it("webkit route scrollbar is compact rather than hidden", () => {
    expect(css).toMatch(
      /\.route-line-scroll::-webkit-scrollbar\s*\{[^}]*height:\s*[4-9]px/s,
    );
    expect(css).not.toMatch(
      /\.route-line-scroll::-webkit-scrollbar\s*\{[^}]*display:\s*none/s,
    );
  });

  it(".route-line-card keeps a readable minimum width", () => {
    const block = extractBlock(".route-line-card");
    expect(block).toMatch(/min-width:\s*184px/);
  });
});

describe("chimera.css — Bug 2 update banner styles", () => {
  it(".route-update-banner block exists", () => {
    expect(css).toContain(".route-update-banner");
  });

  it(".route-update-banner-copy block exists", () => {
    expect(css).toContain(".route-update-banner-copy");
  });

  it(".route-update-banner-actions block exists", () => {
    expect(css).toContain(".route-update-banner-actions");
  });

  it(".route-update-banner-actions button.primary block exists", () => {
    expect(css).toContain("button.primary");
  });
});
