import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const providerFormPath = path.resolve(
  __dirname,
  "../../src/components/providers/forms/ProviderForm.tsx",
);
const grokBuildFormPath = path.resolve(
  __dirname,
  "../../src/components/providers/forms/GrokBuildProviderForm.tsx",
);

const providerFormSource = fs.readFileSync(providerFormPath, "utf8");
const grokBuildFormSource = fs.readFileSync(grokBuildFormPath, "utf8");

describe("Codex auto protocol detection in provider forms", () => {
  it("ProviderForm persists model-level protocol detections for auto mode", () => {
    expect(providerFormSource).toContain("detectCodexApiFormats");
    expect(providerFormSource).toContain("codexModelApiFormats");
  });

  it("ProviderForm never uses another model's protocol when the default model was not detected", () => {
    expect(providerFormSource).toContain(
      "const defaultDetection = detectedFormats[codexModel.trim()];",
    );
    expect(providerFormSource).not.toContain(
      "detectedFormats[codexModel.trim()] ?? Object.values(detectedFormats)[0]",
    );
  });

  it("GrokBuildProviderForm persists model-level protocol detections for auto mode", () => {
    expect(grokBuildFormSource).toContain("detectCodexApiFormats");
    expect(grokBuildFormSource).toContain("codexModelApiFormats");
  });

  it("GrokBuildProviderForm never uses another model's protocol when the default model was not detected", () => {
    expect(grokBuildFormSource).toContain(
      "const defaultModel = upstreamModel.trim() || profile.trim();",
    );
    expect(grokBuildFormSource).toContain(
      "const defaultDetection = detectedFormats[defaultModel];",
    );
    expect(grokBuildFormSource).not.toContain(
      "detectedFormats[upstreamModel.trim()] ??\n          detectedFormats[profile.trim()] ??\n          Object.values(detectedFormats)[0]",
    );
  });
});
