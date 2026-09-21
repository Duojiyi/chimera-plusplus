import { describe, expect, it } from "vitest";
import type { Provider } from "@/types";
import {
  activityStorageKey,
  buildCodexModelCatalog,
  extractCodexMappingRows,
  formatDuration,
  loadOperationRecords,
  resolveCurrentProvider,
  saveOperationRecords,
  setCodexProviderApiKey,
} from "./chimeraUtils";

function provider(id: string, endpoint: string, model: string): Provider {
  return {
    id,
    name: id,
    settingsConfig: {
      auth: {},
      config: `model = "${model}"\nmodel_provider = "custom"\n[model_providers.custom]\nbase_url = "${endpoint}"`,
    },
  } as Provider;
}

describe("resolveCurrentProvider", () => {
  const providers = [
    provider("first", "https://one.example/v1", "claude-a"),
    provider("second", "https://two.example/v1/", "claude-b"),
  ];

  it("matches the live endpoint instead of blindly trusting the stored id", () => {
    const result = resolveCurrentProvider(
      providers,
      "first",
      {
        config:
          'model = "claude-b"\nmodel_provider = "custom"\n[model_providers.custom]\nbase_url = "https://two.example/v1"',
      },
      true,
    );
    expect(result.provider?.id).toBe("second");
    expect(result.source).toBe("live");
  });

  it("reports an external configuration when no provider matches", () => {
    const result = resolveCurrentProvider(
      providers,
      "first",
      {
        config:
          'model = "other"\nmodel_provider = "custom"\n[model_providers.custom]\nbase_url = "https://external.example/v1"',
      },
      true,
    );
    expect(result.provider).toBeNull();
    expect(result.source).toBe("external");
  });
});

describe("operation records", () => {
  it("drops malformed records and persists newest first", () => {
    let value = JSON.stringify([{ nope: true }]);
    const storage = {
      getItem: () => value,
      setItem: (_key: string, next: string) => {
        value = next;
      },
    };
    expect(loadOperationRecords(storage)).toEqual([]);
    saveOperationRecords(
      [
        {
          id: "a",
          timestamp: 1,
          provider: "A",
          action: "切换",
          result: "success",
        },
        {
          id: "b",
          timestamp: 2,
          provider: "B",
          action: "测试",
          result: "error",
        },
      ],
      storage,
    );
    expect(loadOperationRecords(storage).map((record) => record.id)).toEqual([
      "b",
      "a",
    ]);
  });

  it("uses a stable, profile-specific storage key", () => {
    expect(activityStorageKey("D:\\Chimera\\profile-a")).toBe(
      activityStorageKey("d:/chimera/profile-a"),
    );
    expect(activityStorageKey("D:\\Chimera\\profile-a")).not.toBe(
      activityStorageKey("D:\\Chimera\\profile-b"),
    );
  });
});

describe("formatDuration", () => {
  it("formats milliseconds and seconds", () => {
    expect(formatDuration(240)).toBe("240ms");
    expect(formatDuration(1250)).toBe("1.3s");
    expect(formatDuration()).toBe("-");
  });
});

describe("setCodexProviderApiKey", () => {
  it("uses the canonical Codex credential field for Anthropic-compatible providers", () => {
    expect(
      setCodexProviderApiKey(
        {
          ANTHROPIC_AUTH_TOKEN: "obsolete-token",
          ANTHROPIC_API_KEY: "obsolete-key",
          unrelated: true,
        },
        "  sk-current  ",
      ),
    ).toEqual({ OPENAI_API_KEY: "sk-current", unrelated: true });
  });
});

describe("buildCodexModelCatalog", () => {
  it("retains explicit text-only mapping metadata", () => {
    const configured = provider("custom", "https://example.com", "custom-text");
    const rows = [
      { model: "custom-text", inputModalities: ["text"] },
      { model: "custom-vision", inputModalities: ["text", "image"] },
      { model: "custom-context", contextWindow: "200000" },
    ];
    configured.settingsConfig.modelCatalog = {
      models: [...rows, { model: "plain" }],
    };
    const mappings = extractCodexMappingRows(configured);
    expect(mappings).toEqual(rows);
    expect(buildCodexModelCatalog("custom-text", mappings)).toEqual(
      rows.map((row) => ({ ...row, displayName: row.model })),
    );
  });

  it("adds the default model when the provider did not return a catalog", () => {
    expect(buildCodexModelCatalog(" claude-sonnet-5 ", [])).toEqual([
      { model: "claude-sonnet-5", displayName: "claude-sonnet-5" },
    ]);
  });

  it("merges fetched models and preserves a manual display name", () => {
    expect(
      buildCodexModelCatalog(
        "claude-sonnet-5",
        [
          {
            model: "claude-sonnet-5",
            displayName: "Sonnet 5",
            contextWindow: "200000",
          },
        ],
        [
          { id: "claude-opus-5", ownedBy: null },
          { id: "claude-sonnet-5", ownedBy: null },
        ],
      ),
    ).toEqual([
      { model: "claude-opus-5", displayName: "claude-opus-5" },
      {
        model: "claude-sonnet-5",
        displayName: "Sonnet 5",
        contextWindow: "200000",
      },
    ]);
  });
});
