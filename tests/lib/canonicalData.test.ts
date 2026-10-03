import { describe, expect, it } from "vitest";
import { CANONICAL_LINES, CANONICAL_PROVIDERS } from "@/data/canonicalData";
import {
  extractCodexBaseUrl,
  extractCodexModelName,
} from "@/utils/providerConfigUtils";

describe("design preview fixtures", () => {
  it("uses real config parsing without credentials or fabricated probe results", () => {
    expect(CANONICAL_PROVIDERS).toHaveLength(9);
    CANONICAL_PROVIDERS.forEach((provider, index) => {
      const line = CANONICAL_LINES[index];
      const config = String(provider.settingsConfig.config);
      expect(extractCodexBaseUrl(config)).toBe(
        line.endpoint.startsWith("http")
          ? line.endpoint
          : `https://${line.endpoint}`,
      );
      expect(extractCodexModelName(config)).toBe(line.model);
      expect(provider.settingsConfig.auth).toEqual({});
      expect(provider.meta?.apiFormat).toBe(
        line.protocol.includes("Responses")
          ? "openai_responses"
          : line.protocol.includes("Anthropic")
            ? "anthropic"
            : "openai_chat",
      );
    });
  });
});
