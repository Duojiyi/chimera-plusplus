import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { fetchModelsForConfig } from "@/lib/api/model-fetch";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue([]);
});
describe("model discovery request headers", () => {
  it("sends validated gateway headers using the backend parameter name", async () => {
    await fetchModelsForConfig(
      "https://example.com/v1",
      "key",
      false,
      undefined,
      "Agent",
      '{"X-Tenant":"one"}',
    );
    expect(invoke).toHaveBeenCalledWith(
      "fetch_models_for_config",
      expect.objectContaining({
        customHeaders: { "x-tenant": "one" },
        customUserAgent: "Agent",
      }),
    );
  });
  it("supports native provider header objects", async () => {
    await fetchModelsForConfig(
      "https://example.com/v1",
      "key",
      undefined,
      undefined,
      undefined,
      { "HTTP-Referer": "https://example.com" },
    );
    expect(invoke).toHaveBeenCalledWith(
      "fetch_models_for_config",
      expect.objectContaining({
        customHeaders: { "http-referer": "https://example.com" },
      }),
    );
  });
  it.each([
    '{"Authorization":"secret"}',
    '{"X-Key":"secret\\nvalue"}',
    '{"X-Key":42}',
    "not json",
  ])(
    "rejects invalid overrides before sending without echoing secrets: %s",
    async (headers) => {
      await expect(
        fetchModelsForConfig(
          "https://example.com",
          "key",
          false,
          undefined,
          undefined,
          headers,
        ),
      ).rejects.toThrow("Invalid model discovery request headers");
      expect(invoke).not.toHaveBeenCalled();
    },
  );
  it("keeps requests without overrides compatible", async () => {
    await fetchModelsForConfig("https://example.com", "key");
    expect(invoke).toHaveBeenCalledWith("fetch_models_for_config", {
      baseUrl: "https://example.com",
      apiKey: "key",
      isFullUrl: undefined,
      modelsUrl: undefined,
      customUserAgent: undefined,
    });
  });
});
