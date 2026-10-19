import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const APP_PATH = path.resolve(__dirname, "../../src/ChimeraApp.tsx");
const appSource = fs.readFileSync(APP_PATH, "utf8");
// Every line editor's footer and its address test live here.
const FIELDS_PATH = path.resolve(
  __dirname,
  "../../src/components/providers/ProviderEditorFields.tsx",
);
const fieldsSource = fs.readFileSync(FIELDS_PATH, "utf8");

describe("Codex model catalog feedback", () => {
  // Source-level guards only: these do not execute or type-check the Rust backend.
  it("rejects a custom catalog before writing a managed catalog and shares the conflict diagnosis", () => {
    const configSource = fs.readFileSync(
      path.resolve(__dirname, "../../src-tauri/src/codex_config.rs"),
      "utf8",
    );
    const runtimeSource = fs.readFileSync(
      path.resolve(__dirname, "../../src-tauri/src/commands/codex_runtime.rs"),
      "utf8",
    );
    const setter = configSource.slice(
      configSource.indexOf("fn set_codex_model_catalog_json_field("),
      configSource.indexOf("fn set_codex_native_web_search_field("),
    );
    expect(setter).toMatch(
      /return Err\(AppError::Message\(codex_model_catalog_reference_error\(&doc\)\)\);/,
    );
    const prepare = configSource.slice(
      configSource.indexOf(
        "pub(crate) fn prepare_codex_config_text_with_model_catalog(",
      ),
      configSource.indexOf(
        "/// Reverse of `prepare_codex_config_text_with_model_catalog`",
      ),
    );
    const pointerCheck = prepare.indexOf(
      "set_codex_model_catalog_json_field(config_text, Some(&catalog_path))?",
    );
    expect(pointerCheck).toBeGreaterThan(0);
    expect(pointerCheck).toBeLessThan(
      prepare.indexOf(
        "model_catalog: Some(crate::config::json_file_text(&catalog)?)",
      ),
    );
    expect(prepare).not.toMatch(
      /(?:write_json_file|atomic_write|write_codex_live_files)\s*\(/,
    );
    const writerSource = fs.readFileSync(
      path.resolve(__dirname, "../../src-tauri/src/codex_live_write.rs"),
      "utf8",
    );
    expect(writerSource).toContain("pub(crate) fn plan_with_snapshots(");
    expect(writerSource).toContain("observed_catalog");
    expect(writerSource).toContain("observed_projection");
    expect(runtimeSource).toContain(
      ".ok_or_else(|| crate::codex_config::codex_model_catalog_reference_error(&config))?",
    );
    expect(runtimeSource).not.toContain("Codex 配置未引用 Chimera 模型目录");
  });

  it("validates the draft before one apply IPC and retains identity after post-apply verification failure", () => {
    const handler = appSource.slice(
      appSource.indexOf("  const saveProvider ="),
      appSource.indexOf(
        "  useEffect(() => {",
        appSource.indexOf("  const saveProvider ="),
      ),
    );
    // Native tool saves intentionally do not use Codex TOML validation.
    const codexStart = handler.indexOf('if (editorAppId !== "codex")');
    expect(codexStart).toBeGreaterThan(0);
    const save = handler.slice(codexStart);
    expect(save.indexOf("validateCommonConfigSnippet")).toBeGreaterThan(0);
    expect(save.indexOf("validateCommonConfigSnippet")).toBeLessThan(
      save.indexOf("providersApi.updateAndActivate"),
    );
    expect(save).toContain("commonConfigSnippet: commonConfigDraft");
    expect(save).toContain("commonConfigDraft !== undefined");
    expect(save.indexOf("providerCommitted = true")).toBeLessThan(
      save.indexOf("commonConfigBaselineRef.current = commonConfigDraft"),
    );
    expect(save).toContain("if (providerCommitted)");
    expect(save).toContain("线路已保存并应用，但后续配置未完成");
  });

  it("keeps native tool saves separate from Codex common drafts", () => {
    const start = appSource.indexOf("  const saveProvider =");
    const native = appSource.slice(
      start,
      appSource.indexOf('if (editorAppId !== "codex")', start),
    );
    expect(native).toContain(
      "providersApi.addAndActivate(provider, editorAppId, false)",
    );
    expect(native).not.toContain("commonConfigDraft");
    const codex = appSource.slice(
      appSource.indexOf('if (editorAppId !== "codex")', start),
      appSource.indexOf("  useEffect(() => {", start),
    );
    expect(codex).not.toContain("configApi.setCommonConfigSnippet(");
  });

  it("distinguishes a renderer enhancement failure from a model catalog write failure", () => {
    expect(appSource).toContain("模型目录已保存；桌面端模型选择器增强未连接");
    expect(appSource).not.toContain("第三方模型列表注入未生效");
  });

  it("does not use another catalog model's protocol as the selected default model fallback", () => {
    expect(appSource).toContain("codexApiFormatForModel(draft.model)");
    expect(appSource).not.toContain(
      "detectedFormats[draft.model.trim()] ??\n              Object.values(detectedFormats)[0]",
    );
    expect(appSource).not.toContain(
      "detectedFormats[probeModel] ?? Object.values(detectedFormats)[0]",
    );
  });
  it("fetching a catalog never triggers inference protocol probes", () => {
    const fetchHandler = appSource.slice(
      appSource.indexOf("  const fetchModels = async ("),
      appSource.indexOf("  const checkRuntime ="),
    );
    expect(fetchHandler.length).toBeGreaterThan(0);
    expect(fetchHandler).toContain("fetchModelsForConfig(");
    expect(fetchHandler).not.toContain("detectCodexApiFormats(");
    expect(appSource).toContain("<EditorTestAction");
    expect(fieldsSource).toContain("测试地址连通性");
    expect(fieldsSource).toContain("仅测试地址连通性，不验证密钥或模型");
  });

  it("address reachability feedback does not imply verified credentials, models, or inference", () => {
    const start = appSource.indexOf("  const testConnection = async (");
    expect(start).toBeGreaterThan(0);
    const handler = appSource.slice(
      start,
      appSource.indexOf("  useEffect(() => {", start),
    );
    expect(handler).toContain("await vscodeApi.testApiEndpoints([baseUrl]");
    expect(handler).toContain('toast.success("地址可达"');
    expect(handler).toContain("未验证密钥或模型");
    // The shorter copy still describes reachability only, not an inference test.
    expect(handler).not.toContain("detectCodexApiFormats(");
    expect(handler).not.toContain("fetchModelsForConfig(");
    expect(handler).not.toMatch(/\b(?:invoke|fetch)\s*\(/);
  });

  it("the other editors' address test is the same reachability-only request", () => {
    const start = fieldsSource.indexOf("export function useAddressTest(");
    expect(start).toBeGreaterThan(0);
    const hook = fieldsSource.slice(
      start,
      fieldsSource.indexOf("\n}\n", start),
    );
    expect(hook).toContain("vscodeApi.testApiEndpoints([url.trim()]");
    expect(hook).toContain('toast.success("地址可达"');
    expect(hook).toContain("未验证密钥或模型");
    expect(hook).not.toContain("fetchModelsForConfig(");
  });
});
