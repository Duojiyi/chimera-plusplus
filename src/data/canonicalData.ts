// Canonical Sample Data for Chimera++ v2.8.0
// Source of truth: designs/v2.8.0/sample-data.md and Pencil frame exports

import type { Provider } from "@/types";

export interface CanonicalLine {
  id: string;
  name: string;
  category: "official" | "custom";
  sub: string;
  auth: string;
  protocol: string;
  model: string;
  endpoint: string;
  latencyMs: number | null;
  latencyGrade: "快" | "中" | "慢" | "超时" | "需重登";
  mark: string;
  badgeColor: string;
  isOfficial?: boolean;
  isCurrent?: boolean;
  expired?: boolean;
  timeout?: boolean;
  isProxy?: boolean;
  isSlow?: boolean;
}

export const CANONICAL_LINES: CanonicalLine[] = [
  // 1. 官方账号
  {
    id: "canonical-official-main",
    name: "OpenAI 官方 · 主力",
    category: "official",
    sub: "li***@gmail.com · Pro",
    auth: "ChatGPT 登录",
    protocol: "Responses",
    model: "gpt-5.5",
    endpoint: "chatgpt.com",
    latencyMs: 240,
    latencyGrade: "快",
    mark: "主",
    badgeColor: "#1A1E24",
    isOfficial: true,
  },
  {
    id: "canonical-official-work",
    name: "OpenAI 官方 · 工作",
    category: "official",
    sub: "ch***@acme.cn · Business",
    auth: "ChatGPT 登录",
    protocol: "Responses",
    model: "gpt-5.6",
    endpoint: "chatgpt.com",
    latencyMs: 265,
    latencyGrade: "快",
    mark: "工",
    badgeColor: "#1A1E24",
    isOfficial: true,
  },
  {
    id: "canonical-official-backup",
    name: "OpenAI 官方 · 备用",
    category: "official",
    sub: "登录已过期，需要重新登录",
    auth: "ChatGPT 登录",
    protocol: "Responses",
    model: "gpt-5.5",
    endpoint: "chatgpt.com",
    latencyMs: null,
    latencyGrade: "需重登",
    mark: "备",
    badgeColor: "#1A1E24",
    isOfficial: true,
    expired: true,
  },
  // 2. 第三方线路
  {
    id: "canonical-deepseek",
    name: "DeepSeek",
    category: "custom",
    sub: "api.deepseek.com",
    auth: "API 密钥",
    protocol: "自动 · Chat",
    model: "deepseek-v4-pro",
    endpoint: "api.deepseek.com",
    latencyMs: 182,
    latencyGrade: "快",
    mark: "DS",
    badgeColor: "#537197",
    isCurrent: true,
    isProxy: true,
  },
  {
    id: "canonical-kimi",
    name: "Kimi",
    category: "custom",
    sub: "api.moonshot.cn",
    auth: "API 密钥",
    protocol: "自动 · Chat",
    model: "kimi-k2.5",
    endpoint: "api.moonshot.cn",
    latencyMs: 310,
    latencyGrade: "中",
    mark: "Ki",
    badgeColor: "#776894",
    isProxy: true,
  },
  {
    id: "canonical-zhipu",
    name: "智谱 GLM",
    category: "custom",
    sub: "open.bigmodel.cn",
    auth: "API 密钥",
    protocol: "Chat",
    model: "glm-4.6",
    endpoint: "open.bigmodel.cn",
    latencyMs: 1200,
    latencyGrade: "慢",
    isSlow: true,
    mark: "智",
    badgeColor: "#317C80",
    isProxy: true,
  },
  {
    id: "canonical-bailian",
    name: "阿里云百炼",
    category: "custom",
    sub: "dashscope.aliyuncs.com",
    auth: "API 密钥",
    protocol: "自动 · Chat",
    model: "qwen3-coder-plus",
    endpoint: "dashscope.aliyuncs.com",
    latencyMs: 290,
    latencyGrade: "快",
    mark: "百",
    badgeColor: "#61774B",
    isProxy: true,
  },
  {
    id: "canonical-openrouter",
    name: "OpenRouter",
    category: "custom",
    sub: "openrouter.ai",
    auth: "API 密钥",
    protocol: "Responses",
    model: "openai/gpt-5.6",
    endpoint: "openrouter.ai",
    latencyMs: 460,
    latencyGrade: "中",
    mark: "OR",
    badgeColor: "#925D79",
    isProxy: false,
  },
  {
    id: "canonical-custom-relay",
    name: "自建中转",
    category: "custom",
    sub: "10 s 无响应 · 3 分钟前测速",
    auth: "API 密钥",
    protocol: "自动 · Anthropic",
    model: "claude-sonnet-4-6",
    endpoint: "https://gw.lab.internal:8080/v1",
    latencyMs: -1,
    latencyGrade: "超时",
    mark: "自",
    badgeColor: "#8F6446",
    timeout: true,
    isProxy: true,
  },
];

export function toProvider(line: CanonicalLine): Provider {
  return {
    id: line.id,
    name: line.name,
    category: line.category,
    iconColor: line.badgeColor,
    settingsConfig: {
      auth: {},
      config: `model_provider = "custom"\nmodel = ${JSON.stringify(line.model)}\n[model_providers.custom]\nname = ${JSON.stringify(line.name)}\nbase_url = ${JSON.stringify(line.endpoint.startsWith("http") ? line.endpoint : "https://" + line.endpoint)}`,
    },
    meta: {
      apiFormat: line.protocol.includes("Responses")
        ? "openai_responses"
        : line.protocol.includes("Anthropic")
          ? "anthropic"
          : "openai_chat",
    },
  };
}

export const CANONICAL_PROVIDERS: Provider[] = CANONICAL_LINES.map(toProvider);

/** Pencil h6CNmQ / sample-data.md: synthetic visual fixture, never runtime evidence. */
export const CANONICAL_STATION = {
  providerId: "canonical-deepseek",
  latencyMs: 182,
  status: "正常",
  testedAt: "3 分钟前测速",
  runtimeLabel: "CLI 0.61.0 · 运行中",
  hopName: "本地代理",
  hopHint: "Responses → Chat",
  endpointHint: "HTTP 200 · 已连通",
  modelHint: "默认模型 · 128K 上下文",
  receipt:
    "2 分钟前 从 OpenAI 官方 · 主力 切换到 DeepSeek，已写入 config.toml，备份 #0412",
} as const;
