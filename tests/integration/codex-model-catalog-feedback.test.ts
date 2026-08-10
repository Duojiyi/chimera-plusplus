import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const APP_PATH = path.resolve(__dirname, "../../src/ChimeraApp.tsx");
const appSource = fs.readFileSync(APP_PATH, "utf8");

describe("Codex model catalog feedback", () => {
  it("distinguishes a renderer enhancement failure from a model catalog write failure", () => {
    expect(appSource).toContain("模型目录已保存；桌面端模型选择器增强未连接");
    expect(appSource).not.toContain("第三方模型列表注入未生效");
  });

  it("does not use another catalog model's protocol as the selected default model fallback", () => {
    expect(appSource).toContain(
      "const defaultDetection = detectedFormats[draft.model.trim()];",
    );
    expect(appSource).toContain(
      "const detected = detectedFormats[probeModel];",
    );
    expect(appSource).not.toContain(
      "detectedFormats[draft.model.trim()] ??\n              Object.values(detectedFormats)[0]",
    );
    expect(appSource).not.toContain(
      "detectedFormats[probeModel] ?? Object.values(detectedFormats)[0]",
    );
  });
});
