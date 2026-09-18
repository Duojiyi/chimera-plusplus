import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const APP_PATH = path.resolve(__dirname, "../../src/ChimeraApp.tsx");
const appSource = fs.readFileSync(APP_PATH, "utf8");

describe("Codex model catalog feedback", () => {
  it("validates common TOML before committing a provider and retains update identity after partial success", () => {
    const save = appSource.slice(
      appSource.indexOf("  const saveProvider ="),
      appSource.indexOf(
        "  useEffect(() => {",
        appSource.indexOf("  const saveProvider ="),
      ),
    );
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
    expect(appSource).toContain(
      "const defaultDetection = detectedFormats[draft.model.trim()];",
    );
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
    expect(appSource).toContain("自动模式保存时会探测协议，可能产生调用费用");
    expect(appSource).toContain("测试地址连通性");
    expect(appSource).toContain("未验证 Key、模型或推理能力");
  });
});
