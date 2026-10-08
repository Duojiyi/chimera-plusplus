import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import {
  getChimeraHubTemplate,
  getCodexCustomTemplate,
} from "@/config/codexTemplates";
import {
  extractCodexBaseUrl,
  extractCodexModelName,
} from "@/utils/providerConfigUtils";

import { renderHook } from "@testing-library/react";
import {
  generateThirdPartyConfig,
  codexProviderPresets,
} from "@/config/codexProviderPresets";
import { blankSelection, presetDraftSeed } from "@/utils/codexPresetDraft";
import { useCodexConfigState } from "@/components/providers/forms/hooks/useCodexConfigState";

describe("Codex custom templates", () => {
  it.each([getCodexCustomTemplate, getChimeraHubTemplate])(
    "preserves project auth and Responses metadata",
    (getTemplate) => {
      const config = parseToml(getTemplate().config);
      expect(config.model).toBe("gpt-6-astra");
      expect(config.model_reasoning_effort).toBe("high");
      expect(config.model_providers).toMatchObject({
        custom: { wire_api: "responses", requires_openai_auth: false },
      });
      expect(config.disable_response_storage).toBeUndefined();
    },
  );
  it("does not force Codex Goal mode in the custom provider template", () => {
    const template = getCodexCustomTemplate();
    const parsed = parseToml(template.config) as {
      features?: { goals?: boolean };
      model_providers?: Record<string, unknown>;
    };

    expect(template.auth).toEqual({ OPENAI_API_KEY: "" });
    expect(parsed.features?.goals).toBeUndefined();
    expect(parsed.model_providers?.custom).toBeDefined();
  });

  it("provides the editable ChimeraHub key-first template", () => {
    const template = getChimeraHubTemplate();

    expect(template.name).toBe("ChimeraHub");
    expect(template.websiteUrl).toBe("https://api.chimerahub.org/");
    expect(template.auth).toEqual({ OPENAI_API_KEY: "" });
    expect(extractCodexBaseUrl(template.config)).toBe(
      "https://api.chimerahub.org/v1",
    );
    expect(extractCodexModelName(template.config)).toBe("gpt-6-astra");
  });
});

describe("Codex new-line defaults", () => {
  it("seeds blank, built-in and generic custom drafts with gpt-6-astra", () => {
    expect(blankSelection().seed.model).toBe("gpt-6-astra");
    expect(presetDraftSeed(codexProviderPresets[0]).model).toBe("gpt-6-astra");
    expect(
      parseToml(generateThirdPartyConfig("relay", "https://relay.test/v1"))
        .model,
    ).toBe("gpt-6-astra");
  });

  it("preserves explicitly selected upstream models", () => {
    expect(
      parseToml(
        generateThirdPartyConfig(
          "relay",
          "https://relay.test/v1",
          "custom-model",
        ),
      ).model,
    ).toBe("custom-model");
  });

  it.each(['model = "gpt-5.6-sol"', 'model = "my-model"', ""])(
    "does not replace an existing config: %s",
    (config) => {
      const initialData = {
        settingsConfig: { config, auth: { OPENAI_API_KEY: "existing-key" } },
      };
      const { result, rerender } = renderHook(() =>
        useCodexConfigState({ initialData }),
      );
      rerender();
      expect(result.current.codexConfig).toBe(config);
      expect(result.current.codexApiKey).toBe("existing-key");
    },
  );
});
