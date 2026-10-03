/** Layout regression checks for the connected provider table and shared shell. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const CSS_PATH = path.resolve(__dirname, "../../src/chimera.css");
const css = fs.readFileSync(CSS_PATH, "utf8");
const tableCss = fs.readFileSync(
  path.resolve(__dirname, "../../src/components/ProviderLineTable.css"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Helper: extract the text of the FIRST CSS block whose selector matches
// ---------------------------------------------------------------------------
function extractBlock(selector: string, source = css): string {
  // Escape selector for regex use
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s");
  const match = re.exec(source);
  return match ? match[1] : "";
}

describe("provider table scrolling and fixed row geometry", () => {
  it("exposes a thin native scrollbar for long lists", () => {
    const block = extractBlock(".provider-page", tableCss);
    expect(block).toContain("overflow: auto");
    expect(block).toContain("scrollbar-width: thin");
  });
  it("allows the scroll container to fit its parent", () => {
    expect(extractBlock(".provider-page", tableCss)).toContain("min-height: 0");
  });
  it("overrides the global WebKit scrollbar hiding rule", () => {
    const block = extractBlock(".provider-page::-webkit-scrollbar", tableCss);
    expect(block).toContain("display: block");
    expect(block).toContain("width: 6px");
    expect(block).toContain("height: 6px");
  });
  it("keeps Pencil row and action dimensions", () => {
    const block = extractBlock(".provider-table-row", tableCss);
    expect(block).toContain("height: 42px");
    expect(block).toContain("90px 136px");
    expect(block).toContain("gap: 12px");
  });
  it("keeps long cell content inside its column", () => {
    const block = extractBlock(".provider-table-row > *", tableCss);
    expect(block).toContain("min-width: 0");
    expect(block).toContain("text-overflow: ellipsis");
  });
});

describe("chimera.css — Bug 2 update banner styles", () => {
  it(".route-update-banner block exists", () => {
    expect(css).toContain(".route-update-banner");
  });

  it(".route-update-banner-copy block exists", () => {
    expect(css).toContain(".route-update-banner-copy");
  });

  it("uses the Chimera brand color token for the update indicator", () => {
    const block = extractBlock(".route-update-banner > i");
    expect(block).toContain("background: var(--ch-accent)");
    expect(block).not.toContain("var(--accent");
  });

  it(".route-update-banner-actions block exists", () => {
    expect(css).toContain(".route-update-banner-actions");
  });

  it(".route-update-banner-actions button.primary block exists", () => {
    expect(css).toContain("button.primary");
  });

  it("uses the Chimera brand color token for the update action default state", () => {
    const block = extractBlock(".route-update-banner-actions button.primary");
    expect(block).toContain("background: var(--ch-accent)");
    expect(block).not.toContain("var(--accent");
  });
});

describe("chimera.css — runtime information layout", () => {
  it("reserves readable status columns while allowing the path to shrink", () => {
    expect(extractBlock(".runtime-info-strip")).toContain(
      "grid-template-columns: minmax(0, 1fr) 110px 110px",
    );
  });

  it("ellipsizes long paths without expanding the information strip", () => {
    expect(extractBlock(".runtime-info-strip > div")).toContain("min-width: 0");
    expect(extractBlock(".runtime-info-strip span")).toContain("min-width: 0");
    const path = extractBlock(".runtime-info-strip > div:first-child b");
    expect(path).toContain("text-overflow: ellipsis");
    expect(path).toContain("overflow: hidden");
    expect(path).toContain("white-space: nowrap");
    expect(path).toContain("user-select: text");
  });

  it("keeps short status text and icons intact", () => {
    expect(
      extractBlock(".runtime-info-strip > div:not(:first-child) span"),
    ).toContain("white-space: nowrap");
    expect(extractBlock(".runtime-info-strip svg")).toContain("flex-shrink: 0");
  });
});
