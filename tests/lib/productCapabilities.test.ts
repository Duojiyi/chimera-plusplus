import { describe, expect, it } from "vitest";
import {
  canOpenProductView,
  hasEnabledCapability,
  isProductToolVisible,
  productToolViews,
} from "@/lib/productCapabilities";

const enabled = (id: string) => ({
  id,
  available: true,
  enabledByDefault: true,
});

describe("backend-owned release capability gates", () => {
  it.each([
    "official-accounts",
    "prompts",
    "skills-mcp",
    "health",
    "tool-claude",
    "tool-gemini",
    "tool-opencode",
    "tool-pi",
  ])("keeps %s closed without policy data", (view) => {
    expect(canOpenProductView(view, [])).toBe(false);
  });
  it.each([
    "providers",
    "sessions",
    "usage",
    "runtime",
    "appearance",
    "settings",
  ])("preserves the existing Codex %s route", (view) => {
    expect(canOpenProductView(view, [])).toBe(true);
  });
  it.each(["unknown", "__proto__", "constructor", "toString"])(
    "rejects unknown route %s",
    (view) => {
      expect(canOpenProductView(view, [])).toBe(false);
    },
  );
  it.each([
    ["official-accounts", "official_accounts"],
    ["prompts", "prompts"],
    ["health", "config_health"],
    ["tool-claude", "multi_tool"],
    ["tool-gemini", "multi_tool"],
    ["tool-opencode", "multi_tool"],
    ["tool-pi", "multi_tool"],
  ])("requires an available and enabled capability for %s", (view, id) => {
    expect(canOpenProductView(view, [enabled(id)])).toBe(true);
    expect(
      canOpenProductView(view, [{ ...enabled(id), available: false }]),
    ).toBe(false);
    expect(
      canOpenProductView(view, [{ ...enabled(id), enabledByDefault: false }]),
    ).toBe(false);
  });
  it("requires both skills and MCP for their combined route", () => {
    expect(canOpenProductView("skills-mcp", [enabled("skills")])).toBe(false);
    expect(canOpenProductView("skills-mcp", [enabled("mcp")])).toBe(false);
    expect(
      canOpenProductView("skills-mcp", [enabled("skills"), enabled("mcp")]),
    ).toBe(true);
  });
  it("does not enable unavailable appearance mutations", () => {
    expect(
      hasEnabledCapability(
        [{ ...enabled("codex_themes"), available: false }],
        "codex_themes",
      ),
    ).toBe(false);
  });
});

it.each(Object.entries(productToolViews))(
  "gates %s with policy and explicit visibility",
  (view, appId) => {
    expect(canOpenProductView(view, [])).toBe(false);
    expect(canOpenProductView(view, [enabled("multi_tool")])).toBe(true);
    expect(isProductToolVisible(view)).toBe(false);
    expect(isProductToolVisible(view, { [appId]: false })).toBe(false);
    expect(isProductToolVisible(view, { [appId]: true })).toBe(true);
  },
);
