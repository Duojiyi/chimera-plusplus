import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import { codexProviderPresets } from "@/config/codexProviderPresets";

const refreshed = [
  "Kimi",
  "Kimi For Coding",
  "DeepSeek",
  "Bailian",
  "MiniMax",
  "MiniMax en",
  "BaiLing",
];

function preset(name: string) {
  const result = codexProviderPresets.find((entry) => entry.name === name);
  expect(result, name).toBeDefined();
  return result!;
}

describe("Codex catalog refresh", () => {
  it.each(refreshed)(
    "keeps %s endpoint, default model and protocol metadata consistent",
    (name) => {
      const provider = preset(name);
      const config = parseToml(provider.config);
      const custom = (
        config.model_providers as Record<string, Record<string, unknown>>
      ).custom;
      expect(provider.auth).toEqual({ OPENAI_API_KEY: "" });
      expect(custom.requires_openai_auth).toBe(false);
      expect(custom.wire_api).toBe("responses");
      expect(provider.endpointCandidates).toEqual([custom.base_url]);
      expect(config.model).toBe(provider.modelCatalog?.[0].model);
      for (const model of provider.modelCatalog ?? []) {
        if (model.reasoningLevels)
          expect(model.reasoningLevels).toContain(
            config.model_reasoning_effort,
          );
      }
      if (provider.apiFormat === "openai_responses") {
        expect(provider.codexChatReasoning).toBeUndefined();
        expect(provider.promptCacheRouting).toBeUndefined();
      }
    },
  );

  it("pins confirmed MiniMax and BaiLing endpoints without changing the international MiniMax endpoint", () => {
    expect(preset("MiniMax").endpointCandidates).toEqual([
      "https://api.minimax.cn/v1",
    ]);
    expect(preset("MiniMax").websiteUrl).toBe("https://platform.minimax.cn");
    expect(preset("MiniMax").apiKeyUrl).toBe(
      "https://platform.minimax.cn/subscribe/token-plan",
    );
    expect(preset("MiniMax en").endpointCandidates).toEqual([
      "https://api.minimax.io/v1",
    ]);
    expect(preset("BaiLing").endpointCandidates).toEqual([
      "https://api.ant-ling.com/v1",
    ]);
    expect(preset("BaiLing").apiFormat).toBe("openai_chat");
    expect(preset("BaiLing").modelCatalog?.[0].inputModalities).toEqual([
      "text",
    ]);
  });

  it("keeps MiniMax M3 vision, parallel tools and vendor instructions", () => {
    for (const name of ["MiniMax", "MiniMax en"]) {
      expect(preset(name).modelCatalog).toEqual([
        expect.objectContaining({
          model: "MiniMax-M3",
          contextWindow: 1000000,
          supportsParallelToolCalls: true,
          inputModalities: ["text", "image"],
          reasoningLevels: ["none", "high"],
          baseInstructions:
            "You are Codex, a coding agent based on MiniMax-M3. You and the user share the same workspace and collaborate to achieve the user's goals.",
        }),
      ]);
    }
  });

  it("limits DeepSeek vision to the official Flash deployment", () => {
    expect(preset("DeepSeek").modelCatalog?.[0]).toMatchObject({
      model: "deepseek-flash",
      inputModalities: ["text", "image"],
    });
    expect(preset("DeepSeek").modelCatalog?.[1]).toMatchObject({
      model: "deepseek-v4-pro",
      inputModalities: ["text"],
    });
    const hosted = codexProviderPresets
      .filter((entry) => entry.name !== "DeepSeek")
      .flatMap((entry) => entry.modelCatalog ?? [])
      .filter((model) => model.model.includes("deepseek"));
    expect(hosted).toHaveLength(2);
    for (const model of hosted) expect(model.inputModalities).toEqual(["text"]);
  });

  it("uses Qwen's documented default and parallel-tool limits", () => {
    for (const model of preset("Bailian").modelCatalog ?? []) {
      expect(model.reasoningLevels).toEqual(["low", "medium", "xhigh"]);
      expect(model.defaultReasoningLevel).toBe("xhigh");
      expect(model.supportsParallelToolCalls).toBe(false);
    }
    expect(preset("Bailian").modelCatalog?.[1].inputModalities).toEqual([
      "text",
    ]);
    expect(preset("Bailian").modelCatalog?.[2].inputModalities).toEqual([
      "text",
      "image",
    ]);
  });
});
