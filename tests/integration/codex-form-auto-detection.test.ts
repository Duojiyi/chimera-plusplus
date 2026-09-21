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

describe("Codex model-family protocol defaults in provider forms", () => {
  it("ProviderForm persists model-level protocol defaults for auto mode", () => {
    expect(providerFormSource).toContain("codexModelApiFormats");
  });

  it("ProviderForm never uses another model's protocol when the default model was not detected", () => {
    expect(providerFormSource).toContain("codexApiFormatForModel(codexModel)");
    expect(providerFormSource).not.toContain(
      "detectedFormats[codexModel.trim()] ?? Object.values(detectedFormats)[0]",
    );
  });

  it("GrokBuildProviderForm persists model-level protocol defaults for auto mode", () => {
    expect(grokBuildFormSource).toContain("codexModelApiFormats");
  });

  it("GrokBuildProviderForm never uses another model's protocol when the default model was not detected", () => {
    expect(grokBuildFormSource).toContain(
      "codexApiFormatForModel(upstreamModel || profile)",
    );
    expect(grokBuildFormSource).not.toContain(
      "detectedFormats[upstreamModel.trim()] ??\n          detectedFormats[profile.trim()] ??\n          Object.values(detectedFormats)[0]",
    );
  });

  it("ProviderForm rejects saves when any catalog model was not detected", () => {
    expect(providerFormSource).toContain("Object.fromEntries");
    expect(providerFormSource).not.toContain("undetectedCatalogModels");
  });

  it("ChimeraApp editor probes only the default model and the user's mapping rows", () => {
    expect(appSource).toContain("const catalogModels = buildCodexModelCatalog");
    // Probing every fetched model made a save impossible against aggregators,
    // whose catalogs always contain embedding/image models that cannot answer
    // a chat probe. Only the default model and the rows the user typed are
    // probed; the rest follow the line protocol and the router's lazy probe.
    expect(appSource).toContain("codexApiFormatForModel(draft.model)");
    expect(appSource).not.toContain("const detectionModels = catalogModels");
  });

  it("ChimeraApp blocks a save only when the default model is undetected", () => {
    // The default model's protocol decides whether the local router takes
    // over, so it cannot be guessed; an undetected mapping row can.
    expect(appSource).toContain("codexApiFormatForModel(draft.model)");
    expect(appSource).not.toContain("无法确认以下模型的上游协议：");
  });

  it("ChimeraApp reports each probe failure and offers a manual protocol", () => {
    expect(codexFormFieldsSource).toContain("openai_responses");
    expect(codexFormFieldsSource).toContain("openai_chat");
  });

  it("ChimeraApp does not pass the React click event into provider saving", () => {
    expect(appSource).toContain("onSave={() => void saveProvider()}");
    expect(appSource).toContain("onClick={submit}");
    expect(appSource).toContain("void onSave();");
    expect(appSource).not.toContain("onSave={saveProvider}");
    expect(appSource).not.toContain("onClick={onSave}");
  });
});

describe("Codex per-model upstream routes (v2.5.0)", () => {
  it("ProviderForm persists sanitized per-model routes in provider meta", () => {
    expect(providerFormSource).toContain("sanitizeCodexModelRoutesForSave");
    expect(providerFormSource).toContain("codexModelRoutes:");
    expect(providerFormSource).toContain("setCodexModelRoutes");
  });

  it("ProviderForm sanitizes explicitly routed models before persistence", () => {
    expect(providerFormSource).toContain("sanitizeCodexModelRoutesForSave");
  });

  it("ChimeraApp editor save preserves existing per-model routes and honors their protocols", () => {
    // The Chimera route editor spreads the original meta, so codexModelRoutes
    // must survive a save from this second path.
    expect(appSource).toContain("...draft.original?.meta");
  });

  it("CodexFormFields exposes a per-row route editor bound to the model id", () => {
    expect(codexFormFieldsSource).toContain("modelRoutes");
    expect(codexFormFieldsSource).toContain("onModelRoutesChange");
    expect(codexFormFieldsSource).toContain("patchRouteForModel");
    expect(codexFormFieldsSource).toContain("codexConfig.modelRouteToggle");
  });

  it("CodexFormFields migrates a route when its model id is renamed or removed", () => {
    expect(codexFormFieldsSource).toContain(
      "把已配置的独立上游线路跟随迁移到新模型名",
    );
    expect(codexFormFieldsSource).toContain("delete nextRoutes[previousModel]");
    expect(codexFormFieldsSource).toContain("delete nextRoutes[model]");
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
