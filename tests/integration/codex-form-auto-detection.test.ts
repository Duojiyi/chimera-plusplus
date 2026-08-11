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
const appPath = path.resolve(__dirname, "../../src/ChimeraApp.tsx");
const codexFormFieldsPath = path.resolve(
  __dirname,
  "../../src/components/providers/forms/CodexFormFields.tsx",
);

const providerFormSource = fs.readFileSync(providerFormPath, "utf8");
const grokBuildFormSource = fs.readFileSync(grokBuildFormPath, "utf8");
const appSource = fs.readFileSync(appPath, "utf8");
const codexFormFieldsSource = fs.readFileSync(codexFormFieldsPath, "utf8");

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

  it("ProviderForm rejects saves when any catalog model was not detected", () => {
    expect(providerFormSource).toContain(
      "findCodexCatalogModelsWithoutProtocol",
    );
    expect(providerFormSource).toContain("undetectedCatalogModels");
    expect(providerFormSource).toContain("无法确认以下模型的上游协议：");
  });

  it("ChimeraApp editor save probes every catalog model and rejects undetected ones", () => {
    expect(appSource).toContain("const catalogModels = buildCodexModelCatalog");
    expect(appSource).toContain("const detectionModels = catalogModels");
    expect(appSource).toContain("findCodexCatalogModelsWithoutProtocol");
    expect(appSource).toContain("无法确认以下模型的上游协议：");
  });
});

describe("Codex model catalog image capability toggle", () => {
  it("CodexFormFields defaults new catalog rows to text-only", () => {
    expect(codexFormFieldsSource).toContain(
      'createCatalogRow({ inputModalities: ["text"] })',
    );
    expect(codexFormFieldsSource).toContain("catalogInputModalities(");
    expect(codexFormFieldsSource).toContain("catalogRowSupportsImage(");
  });

  it("CodexFormFields exposes an explicit per-row image input checkbox", () => {
    expect(codexFormFieldsSource).toContain("<Checkbox");
    expect(codexFormFieldsSource).toContain(
      "id={`catalog-image-${row.rowId}`}",
    );
    expect(codexFormFieldsSource).toContain("catalogColumnImage");
  });
});
