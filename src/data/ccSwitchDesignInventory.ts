import type { CcSwitchImportInventory } from "@/lib/api/ccSwitchImport";

// Pencil 13G / designs/v2.8.0/sample-data.md §12. Presentation only.
export const CC_SWITCH_DESIGN_INVENTORY: CcSwitchImportInventory = {
  writesLive: false,
  canCommit: false,
  rows: [
    ...["火山方舟", "ModelScope", "Azure OpenAI"].map((name, i) => ({
      app: "codex",
      sourceId: `sample-new-${i}`,
      name,
      status: "new" as const,
      reason: "新增供应商",
      existingIds: [],
    })),
    ...["DeepSeek", "智谱 GLM", "阿里云百炼", "OpenRouter"].map((name, i) => ({
      app: "codex",
      sourceId: `sample-identical-${i}`,
      name,
      status: "identical" as const,
      reason: "与现有配置相同",
      existingIds: [`sample-existing-${i}`],
    })),
    ...["自建中转", "Kimi"].map((name, i) => ({
      app: "codex",
      sourceId: `sample-conflict-${i}`,
      name,
      status: "conflict" as const,
      reason:
        i === 0
          ? "导入端口 8000，现有端口 8080"
          : "导入模型 kimi-k2-turbo，现有 kimi-k2.5",
      existingIds: [`sample-conflict-existing-${i}`],
    })),
    ...["OpenAI 官方（ChatGPT 登录）", "AWS Bedrock", "Vertex AI"].map(
      (name, i) => ({
        app: "codex",
        sourceId: `sample-unsupported-${i}`,
        name,
        status: "unsupported" as const,
        reason: ["登录令牌不能导出", "需要 SigV4 签名", "需要 Google 服务账号"][
          i
        ],
        existingIds: [],
      }),
    ),
  ],
};
