import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const APP_PATH = path.resolve(__dirname, "../../src/ChimeraApp.tsx");
const appSource = fs.readFileSync(APP_PATH, "utf8");

describe("Codex model catalog feedback", () => {
  it("validates common TOML before committing a provider and retains update identity after partial success", () => {
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
    expect(save.indexOf("original: provider")).toBeLessThan(
      save.indexOf("setCommonConfigSnippet"),
    );
    expect(save).toContain("if (providerCommitted)");
    expect(save).toContain("线路已保存并应用，但后续配置未完成");
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
      appSource.indexOf("  const fetchModels = async () =>"),
      appSource.indexOf("  const checkRuntime ="),
    );
    expect(fetchHandler).toContain("fetchModelsForConfig(");
    expect(fetchHandler).not.toContain("detectCodexApiFormats(");
    expect(appSource).toContain("测试地址连通性");
    expect(appSource).toContain("仅测试地址连通性，不验证密钥或模型。");
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
});
