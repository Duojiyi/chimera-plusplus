import { describe, expect, it } from "vitest";
import {
  describeCodexDetectionFailure,
  catalogInputModalities,
  catalogRowSupportsImage,
  codexDraftRouting,
  findCodexCatalogModelsWithoutProtocol,
  sanitizeCodexModelRoutesForSave,
} from "@/chimeraUtils";
import type { CodexModelRoute } from "@/types";

// resolveCurrentProvider moved into the backend
// (`provider_dto::resolve_current_provider`), which still sees raw keys.

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

describe("protocol detection diagnostics", () => {
  it("preserves all protocol error details without treating the first as the cause", () => {
    const reason =
      "openai_responses: HTTP 502 (upstream_error) upstream unavailable | anthropic: HTTP 403 (forbidden) group disallows messages";
    expect(describeCodexDetectionFailure(reason)).toEqual({
      status: "尚未确认协议",
      excerpt: reason,
    });
  });
  it("still accepts legacy errors and missing diagnostics", () => {
    expect(
      describeCodexDetectionFailure("HTTP 401 (unauthorized) bad key"),
    ).toEqual({
      status: "HTTP 401 (unauthorized)",
      excerpt: "bad key",
    });
    expect(describeCodexDetectionFailure(undefined)).toEqual({
      status: "未返回原因",
      excerpt: "",
    });
  });
});

describe("codexDraftRouting 自动审批模型", () => {
  const base = {
    id: "line",
    name: "Line",
    apiFormat: "openai_responses" as const,
    model: "gpt-5",
    catalogModels: [],
    isFullUrl: false,
    customUserAgent: "",
  };
  const saved = {
    id: "line",
    name: "Line",
    settingsConfig: {},
    meta: { codexAutoReviewModel: "saved-reviewer" },
  };
  it("follows the draft value, so a filled field routes the line", () => {
    expect(
      codexDraftRouting({
        ...base,
        original: null,
        codexAutoReviewModel: " reviewer ",
      }).reasons,
    ).toContain("auto-review-model");
  });
  it("treats a cleared field as unset even when the saved line has one", () => {
    expect(
      codexDraftRouting({
        ...base,
        original: saved,
        codexAutoReviewModel: "  ",
      }).reasons,
    ).not.toContain("auto-review-model");
  });
  it("keeps the saved value when the caller does not pass the field", () => {
    expect(codexDraftRouting({ ...base, original: saved }).reasons).toContain(
      "auto-review-model",
    );
  });
});
