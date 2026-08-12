import { describe, expect, it } from "vitest";
import {
  catalogInputModalities,
  catalogRowSupportsImage,
  findCodexCatalogModelsWithoutProtocol,
  resolveCurrentProvider,
  sanitizeCodexModelRoutesForSave,
} from "@/chimeraUtils";
import type { CodexModelRoute, Provider } from "@/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(id: string, baseUrl: string, model = "gpt-4o"): Provider {
  const config = [
    `model_provider = "openai"`,
    baseUrl ? `base_url = "${baseUrl}"` : "",
    `model = "${model}"`,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    id,
    name: id,
    settingsConfig: { config },
  };
}

function liveState(baseUrl: string, model = "gpt-4o") {
  const config = [
    `model_provider = "openai"`,
    baseUrl ? `base_url = "${baseUrl}"` : "",
    `model = "${model}"`,
  ]
    .filter(Boolean)
    .join("\n");
  return { config };
}

// ---------------------------------------------------------------------------
// resolveCurrentProvider
// ---------------------------------------------------------------------------

describe("resolveCurrentProvider", () => {
  const official = makeProvider("codex-official", "");
  const relay = makeProvider("relay-1", "https://relay.example.com/v1");

  // --- edge cases -----------------------------------------------------------

  it("returns none when providers array is empty", () => {
    const result = resolveCurrentProvider([], "relay-1", null, true);
    expect(result).toEqual({ provider: null, source: "none" });
  });

  it("returns stored when liveReadSucceeded is false and storedId matches", () => {
    const result = resolveCurrentProvider(
      [official, relay],
      "relay-1",
      null,
      false,
    );
    expect(result).toEqual({ provider: relay, source: "stored" });
  });

  it("returns external when liveReadSucceeded is false and storedId unknown", () => {
    const result = resolveCurrentProvider(
      [official, relay],
      "unknown-id",
      null,
      false,
    );
    expect(result).toEqual({ provider: null, source: "external" });
  });

  // --- exact live match -----------------------------------------------------

  it("matches by endpoint when live config contains a known base_url", () => {
    const live = liveState("https://relay.example.com/v1");
    const result = resolveCurrentProvider(
      [official, relay],
      "codex-official",
      live,
      true,
    );
    expect(result).toEqual({ provider: relay, source: "live" });
  });

  it("matches official provider when live config has no base_url", () => {
    const live = liveState("");
    const result = resolveCurrentProvider(
      [official, relay],
      "relay-1",
      live,
      true,
    );
    expect(result).toEqual({ provider: official, source: "live" });
  });

  // --- Bug #1 fix: proxy takeover (127.0.0.1 / localhost) -------------------

  it("returns stored provider when live endpoint is 127.0.0.1 (proxy takeover)", () => {
    // Chimera wrote 127.0.0.1:PORT into the live config as part of proxy
    // takeover. No saved provider matches that address; we must fall back to
    // the stored selection (relay-1) rather than returning null / official.
    const live = liveState("http://127.0.0.1:12345");
    const result = resolveCurrentProvider(
      [official, relay],
      "relay-1",
      live,
      true,
    );
    expect(result).toEqual({ provider: relay, source: "stored" });
    // Critically: must NOT return the first provider (official) by mistake
    expect(result.provider?.id).toBe("relay-1");
  });

  it("returns stored provider when live endpoint is localhost (proxy takeover)", () => {
    const live = liveState("http://localhost:9999/v1");
    const result = resolveCurrentProvider(
      [official, relay],
      "relay-1",
      live,
      true,
    );
    expect(result).toEqual({ provider: relay, source: "stored" });
  });

  it("returns external (not official) when proxy active but storedId unknown", () => {
    // Edge: proxy takeover but no matching stored provider → still external
    const live = liveState("http://127.0.0.1:12345");
    const result = resolveCurrentProvider(
      [official, relay],
      "does-not-exist",
      live,
      true,
    );
    expect(result).toEqual({ provider: null, source: "external" });
  });

  it("does not treat a non-loopback 127.x address as local proxy", () => {
    // 127.0.0.2 is not a typical loopback for Chimera; exact match should work
    const nonLoopback = makeProvider("custom", "http://127.0.0.2:8080");
    const live = liveState("http://127.0.0.2:8080");
    // 127.0.0.2 starts with "127.0.0" but NOT "127.0.0.1" — the logic only
    // special-cases "127.0.0.1", so this goes through normal endpoint matching.
    const result = resolveCurrentProvider(
      [official, relay, nonLoopback],
      "relay-1",
      live,
      true,
    );
    // Should match via exact endpoint comparison, not the proxy shortcut
    expect(result.provider?.id).toBe("custom");
  });

  // --- trailing slash / case normalisation ----------------------------------

  it("matches provider regardless of trailing slash on live endpoint", () => {
    const live = liveState("https://relay.example.com/v1/");
    const result = resolveCurrentProvider(
      [official, relay],
      "codex-official",
      live,
      true,
    );
    expect(result).toEqual({ provider: relay, source: "live" });
  });
});

// ---------------------------------------------------------------------------
// catalogInputModalities / catalogRowSupportsImage
// ---------------------------------------------------------------------------

describe("catalogInputModalities", () => {
  it("declares image support only when the user opts in", () => {
    expect(catalogInputModalities(true)).toEqual(["text", "image"]);
    expect(catalogInputModalities(false)).toEqual(["text"]);
  });
});

describe("catalogRowSupportsImage", () => {
  it("returns true when a row explicitly declares image input", () => {
    expect(
      catalogRowSupportsImage({
        model: "custom",
        inputModalities: ["text", "image"],
      }),
    ).toBe(true);
  });

  it("returns false for text-only rows", () => {
    expect(
      catalogRowSupportsImage({ model: "custom", inputModalities: ["text"] }),
    ).toBe(false);
  });

  it("returns false when a row has no explicit declaration", () => {
    expect(catalogRowSupportsImage({ model: "custom" })).toBe(false);
  });

  it("matches image case-insensitively", () => {
    expect(
      catalogRowSupportsImage({
        model: "custom",
        inputModalities: ["TEXT", "IMAGE"],
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findCodexCatalogModelsWithoutProtocol
// ---------------------------------------------------------------------------

describe("findCodexCatalogModelsWithoutProtocol", () => {
  const detected: Record<string, { apiFormat: string }> = {
    "model-a": { apiFormat: "openai_chat" },
    "model-b": { apiFormat: "openai_responses" },
  };

  it("returns an empty list when every catalog model is detected", () => {
    const catalog = [{ model: "model-a" }, { model: "model-b" }];
    expect(findCodexCatalogModelsWithoutProtocol(catalog, detected)).toEqual(
      [],
    );
  });

  it("lists catalog models missing from the detection map", () => {
    const catalog = [
      { model: "model-a" },
      { model: "model-c" },
      { model: "model-d" },
    ];
    expect(findCodexCatalogModelsWithoutProtocol(catalog, detected)).toEqual([
      "model-c",
      "model-d",
    ]);
  });

  it("trims model ids and skips empty rows", () => {
    const catalog = [{ model: "  model-a  " }, { model: "  " }, { model: "" }];
    expect(findCodexCatalogModelsWithoutProtocol(catalog, detected)).toEqual(
      [],
    );
  });

  it("deduplicates repeated undetected models", () => {
    const catalog = [
      { model: "model-x" },
      { model: "model-x" },
      { model: "model-a" },
    ];
    expect(findCodexCatalogModelsWithoutProtocol(catalog, detected)).toEqual([
      "model-x",
    ]);
  });

  it("returns an empty list for an empty catalog", () => {
    expect(findCodexCatalogModelsWithoutProtocol([], detected)).toEqual([]);
  });

  it("exempts models whose enabled route declares an explicit protocol", () => {
    const catalog = [{ model: "routed-model" }, { model: "plain-model" }];
    const routes: Record<string, CodexModelRoute> = {
      "routed-model": {
        baseUrl: "https://route.example.com/v1",
        apiFormat: "anthropic",
      },
    };
    expect(
      findCodexCatalogModelsWithoutProtocol(catalog, detected, routes),
    ).toEqual(["plain-model"]);
  });

  it("does not exempt disabled or protocol-less routes", () => {
    const catalog = [{ model: "paused-model" }, { model: "keyless-model" }];
    const routes: Record<string, CodexModelRoute> = {
      "paused-model": {
        baseUrl: "https://paused.example.com",
        apiFormat: "openai_chat",
        enabled: false,
      },
      "keyless-model": { baseUrl: "https://route.example.com" },
    };
    expect(
      findCodexCatalogModelsWithoutProtocol(catalog, detected, routes),
    ).toEqual(["paused-model", "keyless-model"]);
  });
});

// ---------------------------------------------------------------------------
// sanitizeCodexModelRoutesForSave
// ---------------------------------------------------------------------------

describe("sanitizeCodexModelRoutesForSave", () => {
  it("returns undefined when no route carries a meaningful override", () => {
    expect(sanitizeCodexModelRoutesForSave({})).toBeUndefined();
    expect(
      sanitizeCodexModelRoutesForSave({
        "model-a": {},
        "model-b": { baseUrl: "   ", apiKey: "" },
        "  ": { baseUrl: "https://ignored.example.com" },
      }),
    ).toBeUndefined();
  });

  it("trims values and keeps only explicit overrides", () => {
    const sanitized = sanitizeCodexModelRoutesForSave({
      "  routed-model  ": {
        baseUrl: " https://route.example.com/v1 ",
        apiKey: " route-key ",
        apiFormat: "anthropic",
        isFullUrl: false,
      },
    });
    expect(sanitized).toEqual({
      "routed-model": {
        baseUrl: "https://route.example.com/v1",
        apiKey: "route-key",
        apiFormat: "anthropic",
      },
    });
  });

  it("preserves explicit disable and full-url flags", () => {
    const sanitized = sanitizeCodexModelRoutesForSave({
      "paused-model": {
        baseUrl: "https://paused.example.com",
        isFullUrl: true,
        enabled: false,
      },
    });
    expect(sanitized).toEqual({
      "paused-model": {
        baseUrl: "https://paused.example.com",
        isFullUrl: true,
        enabled: false,
      },
    });
  });
});
