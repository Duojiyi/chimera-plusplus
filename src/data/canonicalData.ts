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

// 官方账号设计示例，非本机登录或额度事实 (Frame 03)
export interface CanonicalOfficialAccount {
  id?: string;
  key: string;
  accountKey?: string;
  name: string;
  displayName?: string;
  shortBadge?: string;
  email: string;
  plan: string;
  status: "valid" | "expired" | "unknown";
  statusText?: string;
  quota5h: any;
  reset5h?: string;
  quotaWeek?: any;
  quotaWeekly?: any;
  resetWeek?: string;
  isCurrentInAuthJson?: boolean;
  activeInLive?: boolean;
  mark?: string;
  lastCheckedQuotaTime?: string;
}

export const CANONICAL_OFFICIAL_ACCOUNTS: CanonicalOfficialAccount[] = [
  {
    key: "acc-main",
    name: "OpenAI 官方 · 主力",
    email: "li***@gmail.com",
    plan: "Pro",
    status: "valid",
    statusText: "登录有效",
    quota5h: 62,
    reset5h: "17:55 重置",
    quotaWeek: 41,
    resetWeek: "周一 08:00 重置",
    isCurrentInAuthJson: true,
    mark: "主",
  },
  {
    key: "acc-work",
    name: "OpenAI 官方 · 工作",
    email: "ch***@acme.cn",
    plan: "Business",
    status: "valid",
    statusText: "登录有效",
    quota5h: 100,
    reset5h: "查看额度",
    quotaWeek: 100,
    resetWeek: "查看额度",
    isCurrentInAuthJson: false,
    mark: "工",
  },
  {
    key: "acc-backup",
    name: "OpenAI 官方 · 备用",
    email: "li***@outlook.com",
    plan: "Plus",
    status: "expired",
    statusText: "需要重新登录",
    quota5h: 0,
    reset5h: "无法查询",
    quotaWeek: 0,
    resetWeek: "无法查询",
    isCurrentInAuthJson: false,
    mark: "备",
  },
];

// 用量统计事实数据 (Frame 08)
export const CANONICAL_USAGE_DATA = {
  totalTokensMillion: 1578,
  deltaPercent: 8,
  estimatedCost: 123.16,
  sessionFilesCount: 127,
  cacheHitPercent: 62,
  dailyStats: [
    {
      day: "周一 21",
      total: 142,
      deepseek: 90,
      main: 0,
      kimi: 30,
      zhipu: 0,
      bailian: 22,
      openrouter: 0,
    },
    {
      day: "周二 22",
      total: 198,
      deepseek: 158,
      main: 0,
      kimi: 0,
      zhipu: 40,
      bailian: 0,
      openrouter: 0,
    },
    {
      day: "周三 23",
      total: 176,
      deepseek: 122,
      main: 0,
      kimi: 0,
      zhipu: 38,
      bailian: 0,
      openrouter: 16,
    },
    {
      day: "周四 24",
      total: 231,
      deepseek: 149,
      main: 0,
      kimi: 47,
      zhipu: 0,
      bailian: 35,
      openrouter: 0,
    },
    {
      day: "周五 25",
      total: 188,
      deepseek: 134,
      main: 0,
      kimi: 0,
      zhipu: 32,
      bailian: 22,
      openrouter: 0,
    },
    {
      day: "周六 26",
      total: 296,
      deepseek: 88,
      main: 208,
      kimi: 0,
      zhipu: 0,
      bailian: 0,
      openrouter: 0,
    },
    {
      day: "周日 27",
      total: 347,
      deepseek: 0,
      main: 186,
      kimi: 97,
      zhipu: 0,
      bailian: 0,
      openrouter: 64,
    },
  ],
  modelDistribution: [
    {
      model: "deepseek-v4-pro",
      percent: 47,
      tokens: "741 万",
      color: "#537197",
    },
    { model: "gpt-5.5", percent: 25, tokens: "394 万", color: "#1A1E24" },
    { model: "kimi-k2.5", percent: 11, tokens: "174 万", color: "#776894" },
    { model: "glm-4.6", percent: 7, tokens: "110 万", color: "#0D9488" },
    {
      model: "qwen3-coder-plus",
      percent: 5,
      tokens: "79 万",
      color: "#61774B",
    },
    { model: "openai/gpt-5.6", percent: 5, tokens: "80 万", color: "#9E4877" },
  ],
  topConversations: [
    {
      title: "拆分用量汇总里的子代理归属",
      time: "昨天 21:12",
      line: "主力",
      tokens: "208 万",
      cost: "订阅内",
      subagents: 3,
    },
    {
      title: "修复 config.toml 迁移时丢失 profile 的问题",
      time: "今天 14:20",
      line: "主力",
      tokens: "186 万",
      cost: "订阅内",
      subagents: 2,
    },
    {
      title: "为线路列表加上键盘上下选择",
      time: "今天 11:05",
      line: "Kimi",
      tokens: "97 万",
      cost: "¥ 4.85",
      subagents: 1,
    },
    {
      title: "把 cc-switch 导入改成四类结果",
      time: "昨天 16:30",
      line: "DeepSeek",
      tokens: "88 万",
      cost: "¥ 10.56",
      subagents: 0,
    },
    {
      title: "排查 OpenRouter 返回 429 的重试间隔",
      time: "今天 09:40",
      line: "OpenRouter",
      tokens: "64 万",
      cost: "¥ 9.60",
      subagents: 0,
    },
  ],
};

// 配置体检事实数据 (Frame 10)
export interface CanonicalHealthItem {
  id: string;
  severity: "critical" | "warning" | "pass" | "error";
  title: string;
  desc?: string;
  location?: string;
  impact?: string;
  solution?: string;
  actionLabel?: string;
  resolved?: boolean;
  diffLines?: {
    lineNumber: number;
    type: "add" | "delete" | "context";
    code: string;
  }[];
}

export const CANONICAL_HEALTH_ITEMS: CanonicalHealthItem[] = [
  {
    id: "health-01",
    severity: "critical",
    title: "config.toml 里有两个同名 profile「work」",
    location: "C:\\Users\\lin\\.codex\\config.toml · 第 42 行、第 88 行",
    impact: "Codex 只读第一个，第 88 行里较新的模型设置不会生效。",
    solution: "修复：保留第 88 行，删除第 42 至 44 行。",
    actionLabel: "修复",
    diffLines: [
      { lineNumber: 42, type: "delete", code: "[profiles.work]" },
      { lineNumber: 43, type: "delete", code: 'model = "gpt-5.5"' },
      {
        lineNumber: 44,
        type: "delete",
        code: 'model_reasoning_effort = "high"',
      },
      { lineNumber: 88, type: "context", code: "[profiles.work]" },
      { lineNumber: 89, type: "context", code: 'model = "gpt-5.6"' },
    ],
  },
  {
    id: "health-02",
    severity: "critical",
    title: "本地代理端口 15721 被占用",
    location: "node.exe · PID 18244 · 已占用 12 分钟",
    impact: "导致 5 条依赖代理的线路无法转发，请求直接拒绝连接。",
    solution: "修复：改用空闲备用端口 15722 重启本地代理。",
    actionLabel: "改用 15722",
  },
  {
    id: "health-03",
    severity: "critical",
    title: "auth.json 权限过宽（0664）",
    location: "C:\\Users\\lin\\.codex\\auth.json · -rw-rw-r--",
    impact: "同机其它非特权用户可直接读取 OpenAI 与 GitHub 登录 Token。",
    solution: "修复：收紧 NTFS ACL 权限至仅当前用户完全控制（0600）。",
    actionLabel: "收紧权限",
  },
  {
    id: "health-04",
    severity: "warning",
    title: "自建中转测速超时",
    location: "14:19 全部测速时 10 s 无响应 · 地址 gw.lab.internal:8080 已失效",
    impact: "该线路当前无法正常调用，自动回退可能导致单点过载。",
    solution:
      "建议：网关已迁移至 8443 端口，建议在编辑面板中更新线路目标地址。",
    actionLabel: "编辑线路",
  },
  {
    id: "health-05",
    severity: "warning",
    title: "config.toml 仍在使用旧版顶层 model 字段",
    location: "C:\\Users\\lin\\.codex\\config.toml · 第 3 行",
    impact: "Codex 0.61.0 起已弃用顶层 model，未来大版本更新时可能报错。",
    solution: "建议：迁移至标准 profiles.default 结构。",
    actionLabel: "迁移",
  },
];

// 提示词事实数据 (Frame 05)
export interface CanonicalPromptItem {
  id: string;
  name: string;
  title?: string;
  category?: "builtin" | "imported";
  origin: "builtin" | "imported";
  originLabel: string;
  summary: string;
  description?: string;
  enabled: boolean;
  app: string;
  rules?: string[];
}

export const CANONICAL_PROMPTS: CanonicalPromptItem[] = [
  {
    id: "prompt-1",
    name: "严格代码审计与防御性编程",
    origin: "builtin",
    originLabel: "内置",
    summary: "执行安全边界防泄漏审查、CAS 写入校验、跨平台路径注入拦截",
    enabled: true,
    app: "codex",
  },
  {
    id: "prompt-2",
    name: "简明高效 Senior Dev (Ponytail Mode)",
    origin: "builtin",
    originLabel: "内置",
    summary:
      "非必要不写代码，优先复用原生能力，单行解决不写多行，保持极简最小 Diff",
    enabled: true,
    app: "codex",
  },
  {
    id: "prompt-3",
    name: "TypeScript 强类型与状态机保护",
    origin: "builtin",
    originLabel: "内置",
    summary: "严格杜绝 any，完备 Discriminated Union 状态穷举与 React 卸载守卫",
    enabled: true,
    app: "codex",
  },
  {
    id: "prompt-4",
    name: "前端组件 1:1 像素级还原规范",
    origin: "builtin",
    originLabel: "内置",
    summary: "严格对齐 Pencil 设计稿导出的尺寸、颜色、排版、交互与数据口径",
    enabled: false,
    app: "codex",
  },
  {
    id: "prompt-5",
    name: "Git 提交信息规范 (Conventional Commits)",
    origin: "builtin",
    originLabel: "内置",
    summary: "自动根据变更生成清晰的 feat/fix/refactor/docs 规范提交消息",
    enabled: false,
    app: "codex",
  },
  {
    id: "prompt-6",
    name: "测试驱动与断言自检规范",
    origin: "builtin",
    originLabel: "内置",
    summary: "非平凡逻辑附带单个精简自检，无冗余脚手架，保证回归可靠",
    enabled: false,
    app: "codex",
  },
  {
    id: "prompt-7",
    name: "团队内部开发准则 (Team Guidelines)",
    origin: "imported",
    originLabel: "导入",
    summary:
      "从 instructions/team-rules.md 导入的受管片段，映射到 AGENTS.md 末尾",
    enabled: false,
    app: "codex",
  },
];

// Skills 与 MCP 事实数据 (Frame 06 / 06B)
export interface CanonicalSkill {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  enabled: boolean;
  source?: string;
  note?: string;
}

export const CANONICAL_SKILLS: CanonicalSkill[] = [
  {
    id: "skill-1",
    name: "git-workflow",
    version: "1.2.0",
    description: "自动化分支管理、rebase 辅助与原子提交整理",
    author: "openai",
    enabled: true,
    source: "内置",
  },
  {
    id: "skill-2",
    name: "code-review",
    version: "2.0.1",
    description: "代码静态深度审查、圈复杂度与潜在死锁探测",
    author: "community",
    enabled: true,
    source: "社区",
  },
  {
    id: "skill-3",
    name: "rust-fmt-checker",
    version: "0.9.4",
    description: "零编译开销源码语法检查与格式统一",
    author: "chimera",
    enabled: true,
    source: "团队",
  },
  {
    id: "skill-4",
    name: "terminal-runner",
    version: "1.1.0",
    description: "安全沙箱内的长命令与后台常驻任务执行",
    author: "openai",
    enabled: true,
    source: "内置",
  },
  {
    id: "skill-5",
    name: "web-search-mcp",
    version: "1.0.3",
    description: "聚合搜索引擎索引与实时在线文档摘录",
    author: "google",
    enabled: false,
    source: "社区",
  },
  {
    id: "skill-6",
    name: "playwright-browser",
    version: "0.8.2",
    description: "端到端前端渲染检查与无头浏览器截图",
    author: "microsoft",
    enabled: false,
    source: "社区",
  },
  {
    id: "skill-7",
    name: "db-schema-inspector",
    version: "1.4.0",
    description: "SQLite WAL 日志与表迁移版本验证",
    author: "chimera",
    enabled: false,
    source: "团队",
  },
];

export interface CanonicalMcpServer {
  id: string;
  name: string;
  transport: "stdio" | "http";
  commandOrUrl: string;
  command?: string;
  sourceCommand?: string;
  args: string[];
  status: "connected" | "disabled";
  enabled?: boolean;
  description: string;
  note?: string;
  envMasked?: Record<string, string>;
}

export const CANONICAL_MCP_SERVERS: CanonicalMcpServer[] = [
  {
    id: "mcp-git",
    name: "Git VCS Helper",
    transport: "stdio",
    commandOrUrl: "npx",
    args: ["-y", "@modelcontextprotocol/server-git"],
    status: "connected",
    description: "本地 Git 仓库历史读取、暂存区操作与冲突探测",
  },
  {
    id: "mcp-fetch",
    name: "HTTP Web Fetcher",
    transport: "stdio",
    commandOrUrl: "uvx",
    args: ["mcp-server-fetch"],
    status: "connected",
    description: "对外网络资源与 API 文档安全爬取抓取",
  },
  {
    id: "mcp-filesystem",
    name: "Secure Filesystem",
    transport: "stdio",
    commandOrUrl: "npx",
    args: [
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "d:\\Desktop\\chimera-plusplus",
    ],
    status: "connected",
    description: "限制在项目根目录工作空间内的原子读写沙箱",
  },
  {
    id: "mcp-memory",
    name: "Knowledge Memory Graph",
    transport: "stdio",
    commandOrUrl: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    status: "disabled",
    description: "跨会话的实体关系知识图谱与长期偏好记忆",
  },
];

// 会话事实数据 (Frame 07)
export interface CanonicalSession {
  id: string;
  dateGroup: "今天" | "昨天" | "9 月 25 日";
  title: string;
  lineName: string;
  lineModel: string;
  timeRange: string;
  duration: string;
  rounds: number;
  tokensTotal: string;
  tokensInput: string;
  tokensOutput: string;
  cost: string;
  subagentsCount: number;
  resumeCmd: string;
}

export const CANONICAL_SESSIONS: CanonicalSession[] = [
  {
    id: "0199a3f2-7c41",
    dateGroup: "今天",
    title: "修复 config.toml 迁移时丢失 profile 的问题",
    lineName: "主力",
    lineModel: "gpt-5.5",
    timeRange: "13:08–14:20",
    duration: "1 小时 12 分",
    rounds: 38,
    tokensTotal: "186 万",
    tokensInput: "142 万",
    tokensOutput: "44 万",
    cost: "订阅内",
    subagentsCount: 2,
    resumeCmd: "codex resume 0199a3f2-7c41",
  },
  {
    id: "0199a2e1-4b12",
    dateGroup: "今天",
    title: "为线路列表加上键盘上下选择",
    lineName: "Kimi",
    lineModel: "kimi-k2.5",
    timeRange: "09:58–11:05",
    duration: "1 小时 7 分",
    rounds: 12,
    tokensTotal: "97 万",
    tokensInput: "76 万",
    tokensOutput: "21 万",
    cost: "¥ 4.85",
    subagentsCount: 1,
    resumeCmd: "codex resume 0199a2e1-4b12",
  },
  {
    id: "0199a19d-8f33",
    dateGroup: "今天",
    title: "排查 OpenRouter 返回 429 的重试间隔",
    lineName: "OpenRouter",
    lineModel: "openai/gpt-5.6",
    timeRange: "09:04–09:40",
    duration: "36 分钟",
    rounds: 6,
    tokensTotal: "64 万",
    tokensInput: "52 万",
    tokensOutput: "12 万",
    cost: "¥ 9.60",
    subagentsCount: 0,
    resumeCmd: "codex resume 0199a19d-8f33",
  },
  {
    id: "01999e44-1a92",
    dateGroup: "昨天",
    title: "拆分用量汇总里的子代理归属",
    lineName: "主力",
    lineModel: "gpt-5.5",
    timeRange: "19:52–21:12",
    duration: "1 小时 20 分",
    rounds: 54,
    tokensTotal: "208 万",
    tokensInput: "162 万",
    tokensOutput: "46 万",
    cost: "订阅内",
    subagentsCount: 3,
    resumeCmd: "codex resume 01999e44-1a92",
  },
  {
    id: "019999ac-3f77",
    dateGroup: "昨天",
    title: "把 cc-switch 导入改成四类结果",
    lineName: "DeepSeek",
    lineModel: "deepseek-v4-pro",
    timeRange: "15:10–16:30",
    duration: "1 小时 20 分",
    rounds: 22,
    tokensTotal: "88 万",
    tokensInput: "70 万",
    tokensOutput: "18 万",
    cost: "¥ 10.56",
    subagentsCount: 0,
    resumeCmd: "codex resume 019999ac-3f77",
  },
  {
    id: "01998f12-9c04",
    dateGroup: "9 月 25 日",
    title: "整理 v2.8.0 升级计划的风险表",
    lineName: "DeepSeek",
    lineModel: "deepseek-v4-pro",
    timeRange: "19:40–20:48",
    duration: "1 小时 8 分",
    rounds: 20,
    tokensTotal: "134 万",
    tokensInput: "105 万",
    tokensOutput: "29 万",
    cost: "¥ 16.08",
    subagentsCount: 0,
    resumeCmd: "codex resume 01998f12-9c04",
  },
];

// 备份记录 (Frame 11 设置)
export interface CanonicalBackup {
  id: string;
  number: string;
  time: string;
  trigger: string;
  files: string;
  size: string;
}

export const CANONICAL_BACKUPS: CanonicalBackup[] = [
  {
    id: "backup-0412",
    number: "#0412",
    time: "今天 14:20",
    trigger: "切换到 DeepSeek 前",
    files: "config.toml",
    size: "8 KB",
  },
  {
    id: "backup-0411",
    number: "#0411",
    time: "今天 12:55",
    trigger: "切换到 OpenAI 官方 · 主力 前",
    files: "auth.json、config.toml",
    size: "11 KB",
  },
  {
    id: "backup-0410",
    number: "#0410",
    time: "今天 09:52",
    trigger: "切换到 Kimi 前",
    files: "config.toml",
    size: "8 KB",
  },
  {
    id: "backup-0409",
    number: "#0409",
    time: "今天 09:02",
    trigger: "切换到 OpenRouter 前",
    files: "config.toml",
    size: "8 KB",
  },
  {
    id: "backup-0408",
    number: "#0408",
    time: "昨天 21:14",
    trigger: "编辑「自建中转」前",
    files: "routes.json",
    size: "3 KB",
  },
];

// 皮肤事实数据 (Frame 09B 外观)
export interface CanonicalSkin {
  id: string;
  name: string;
  author: string;
  license: string;
  mode: "dark" | "light";
  version: string;
  isApplied?: boolean;
  isTrying?: boolean;
  accentColor: string;
  bgColor: string;
  sidebarColor: string;
}

export const CANONICAL_SKINS: CanonicalSkin[] = [
  {
    id: "graphite-night",
    name: "石墨夜",
    author: "lin",
    license: "MIT",
    mode: "dark",
    version: "1.2.0",
    isTrying: true,
    accentColor: "#357B7F",
    bgColor: "#16191D",
    sidebarColor: "#1F2328",
  },
  {
    id: "cyberpunk",
    name: "赛博朋克",
    author: "neon",
    license: "MIT",
    mode: "dark",
    version: "2.0.1",
    accentColor: "#F50057",
    bgColor: "#0F0F1B",
    sidebarColor: "#181829",
  },
  {
    id: "nordic-aurora",
    name: "北极光",
    author: "aurora",
    license: "Apache-2.0",
    mode: "dark",
    version: "1.0.4",
    accentColor: "#88C0D0",
    bgColor: "#2E3440",
    sidebarColor: "#3B4252",
  },
  {
    id: "warm-solar",
    name: "暖阳白",
    author: "solar",
    license: "MIT",
    mode: "light",
    version: "1.1.0",
    accentColor: "#F59E0B",
    bgColor: "#FFFDF9",
    sidebarColor: "#F8F5EE",
  },
  {
    id: "papyrus",
    name: "纸莎草",
    author: "scribe",
    license: "MIT",
    mode: "light",
    version: "1.0.0",
    accentColor: "#854D0E",
    bgColor: "#FEFCE8",
    sidebarColor: "#FEF9C3",
  },
  {
    id: "cedar-forest",
    name: "森林绿",
    author: "cedar",
    license: "MIT",
    mode: "dark",
    version: "1.3.2",
    accentColor: "#10B981",
    bgColor: "#064E3B",
    sidebarColor: "#065F46",
  },
];

// 多工具定义 (Frame 04A/04B)
export interface CanonicalToolInfo {
  id: string;
  name: string;
  shortName: string;
  category: "switch" | "accumulate"; // 切换类 vs 累加类
  categoryLabel: string;
  description: string;
  configPath: string;
  color: string;
  activeCount?: string;
  currentLineBadge?: string;
  currentLineColor?: string;
}

export const CANONICAL_TOOLS: CanonicalToolInfo[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    shortName: "CC",
    category: "switch",
    categoryLabel: "切换类",
    description:
      "同一时间只走一条线路 · 共 4 条 · 写入 C:\\Users\\lin\\.claude\\settings.json",
    configPath: "C:\\Users\\lin\\.claude\\settings.json",
    color: "#D97706",
    currentLineBadge: "智",
    currentLineColor: "#61A6AA",
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    shortName: "Gm",
    category: "switch",
    categoryLabel: "切换类",
    description:
      "同一时间只走一条线路 · 共 2 条 · 写入 C:\\Users\\lin\\.gemini\\config.json",
    configPath: "C:\\Users\\lin\\.gemini\\config.json",
    color: "#2563EB",
    currentLineBadge: "官",
    currentLineColor: "#BABEC3",
  },
  {
    id: "opencode",
    name: "OpenCode",
    shortName: "OC",
    category: "accumulate",
    categoryLabel: "累加类",
    description:
      "同时启用多个供应商 · 启用 3/5 · 写入 C:\\Users\\lin\\.config\\opencode\\config.json",
    configPath: "C:\\Users\\lin\\.config\\opencode\\config.json",
    color: "#10B981",
    activeCount: "3/5",
  },
  {
    id: "pi",
    name: "Pi",
    shortName: "Pi",
    category: "accumulate",
    categoryLabel: "累加类",
    description:
      "同时启用多个模型提供方 · 启用 2/3 · 写入 C:\\Users\\lin\\.pi\\models.json",
    configPath: "C:\\Users\\lin\\.pi\\models.json",
    color: "#8B5CF6",
    activeCount: "2/3",
  },
];

export interface CanonicalSettingsTool {
  id: string;
  name: string;
  shortName: string;
  category: "switch" | "accumulate";
  categoryLabel: "切换类" | "累加类";
  status: "enabled" | "detected" | "not_installed";
  statusLabel: string;
  version?: string;
  badge?: string;
  badgeColor?: string;
  badgeSub?: string;
  countText?: string;
  canInstall?: boolean;
}

export const CANONICAL_SETTINGS_TOOLS: CanonicalSettingsTool[] = [
  {
    id: "codex",
    name: "Codex",
    shortName: "Cx",
    category: "switch",
    categoryLabel: "切换类",
    status: "enabled",
    statusLabel: "始终显示",
    version: "0.61.0",
    badge: "DS",
    badgeColor: "#7B9BC3",
    badgeSub: "当前 DeepSeek",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    shortName: "CC",
    category: "switch",
    categoryLabel: "切换类",
    status: "enabled",
    statusLabel: "已启用（9 月 19 日，#0391）",
    version: "2.1.9",
    badge: "智",
    badgeColor: "#61A6AA",
    badgeSub: "当前 智谱 GLM · 210 ms",
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    shortName: "CD",
    category: "switch",
    categoryLabel: "切换类",
    status: "not_installed",
    statusLabel: "未检测到安装",
    canInstall: true,
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    shortName: "Gm",
    category: "switch",
    categoryLabel: "切换类",
    status: "enabled",
    statusLabel: "已启用",
    version: "0.9.2",
    badge: "官",
    badgeColor: "#BABEC3",
    badgeSub: "Google 官方登录",
  },
  {
    id: "grok-build",
    name: "Grok Build",
    shortName: "Gk",
    category: "switch",
    categoryLabel: "切换类",
    status: "detected",
    statusLabel: "未启用（已检测到）",
    version: "0.4.1",
  },
  {
    id: "opencode",
    name: "OpenCode",
    shortName: "OC",
    category: "accumulate",
    categoryLabel: "累加类",
    status: "enabled",
    statusLabel: "已启用",
    version: "1.2.0",
    countText: "3/5",
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    shortName: "Cl",
    category: "accumulate",
    categoryLabel: "累加类",
    status: "detected",
    statusLabel: "未启用（已检测到）",
    version: "1.4.2",
  },
  {
    id: "hermes",
    name: "Hermes",
    shortName: "He",
    category: "accumulate",
    categoryLabel: "累加类",
    status: "not_installed",
    statusLabel: "未检测到安装",
    canInstall: true,
  },
  {
    id: "pi",
    name: "Pi",
    shortName: "Pi",
    category: "accumulate",
    categoryLabel: "累加类",
    status: "enabled",
    statusLabel: "已启用",
    version: "0.7.3",
    countText: "2/3",
  },
  {
    id: "mcode",
    name: "MiniMax Code",
    shortName: "Mc",
    category: "accumulate",
    categoryLabel: "累加类",
    status: "detected",
    statusLabel: "未启用（已检测到）",
    version: "0.3.0",
  },
];

export interface CanonicalCcSwitchItem {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  category: "new" | "identical" | "conflict" | "unsupported";
  categoryLabel: "新增" | "与现有相同" | "冲突" | "不支持";
  description: string;
  checked?: boolean;
}

export const CANONICAL_CC_SWITCH_IMPORT_ITEMS: CanonicalCcSwitchItem[] = [
  // 1. 新增 (3) 默认勾选
  {
    id: "cc-ark",
    name: "火山方舟",
    endpoint: "ark.cn-beijing.volces.com",
    model: "doubao-seed-code",
    category: "new",
    categoryLabel: "新增",
    description: "默认勾选 · 导入为新线路",
    checked: true,
  },
  {
    id: "cc-modelscope",
    name: "ModelScope",
    endpoint: "api-inference.modelscope.cn",
    model: "Qwen3-Coder-480B-A35B",
    category: "new",
    categoryLabel: "新增",
    description: "默认勾选 · 导入为新线路",
    checked: true,
  },
  {
    id: "cc-azure",
    name: "Azure OpenAI",
    endpoint: "acme-openai.openai.azure.com",
    model: "gpt-5.5",
    category: "new",
    categoryLabel: "新增",
    description: "默认勾选 · 导入为新线路",
    checked: true,
  },
  // 2. 与现有相同 (4) 跳过
  {
    id: "cc-deepseek",
    name: "DeepSeek",
    endpoint: "api.deepseek.com",
    model: "deepseek-v4-pro",
    category: "identical",
    categoryLabel: "与现有相同",
    description: "已存在相同配置 · 跳过，不写入",
    checked: false,
  },
  {
    id: "cc-zhipu",
    name: "智谱 GLM",
    endpoint: "open.bigmodel.cn",
    model: "glm-4.6",
    category: "identical",
    categoryLabel: "与现有相同",
    description: "已存在相同配置 · 跳过，不写入",
    checked: false,
  },
  {
    id: "cc-bailian",
    name: "阿里云百炼",
    endpoint: "dashscope.aliyuncs.com",
    model: "qwen3-coder-plus",
    category: "identical",
    categoryLabel: "与现有相同",
    description: "已存在相同配置 · 跳过，不写入",
    checked: false,
  },
  {
    id: "cc-openrouter",
    name: "OpenRouter",
    endpoint: "openrouter.ai",
    model: "openai/gpt-5.6",
    category: "identical",
    categoryLabel: "与现有相同",
    description: "已存在相同配置 · 跳过，不写入",
    checked: false,
  },
  // 3. 冲突 (2)
  {
    id: "cc-custom-relay",
    name: "自建中转",
    endpoint: "gw.lab.internal:8000/v1",
    model: "claude-sonnet-4-6",
    category: "conflict",
    categoryLabel: "冲突",
    description: "cc-switch 中是 :8000/v1，现有为 :8080/v1 · 默认保留现有",
    checked: false,
  },
  {
    id: "cc-kimi",
    name: "Kimi",
    endpoint: "api.moonshot.cn",
    model: "kimi-k2-turbo",
    category: "conflict",
    categoryLabel: "冲突",
    description:
      "cc-switch 模型为 kimi-k2-turbo，现有为 kimi-k2.5 · 默认保留现有",
    checked: false,
  },
  // 4. 不支持 (3)
  {
    id: "cc-openai-official",
    name: "OpenAI 官方",
    endpoint: "chatgpt.com",
    model: "gpt-5.5",
    category: "unsupported",
    categoryLabel: "不支持",
    description: "ChatGPT Web 登录令牌不可导出，请在「官方账号」中独立登录",
    checked: false,
  },
  {
    id: "cc-aws-bedrock",
    name: "AWS Bedrock",
    endpoint: "bedrock-runtime.us-east-1.amazonaws.com",
    model: "anthropic.claude-3-5-sonnet",
    category: "unsupported",
    categoryLabel: "不支持",
    description: "需要 SigV4 动态签名认证，当前暂不支持导入",
    checked: false,
  },
  {
    id: "cc-vertex-ai",
    name: "Google Vertex AI",
    endpoint: "us-central1-aiplatform.googleapis.com",
    model: "gemini-1.5-pro",
    category: "unsupported",
    categoryLabel: "不支持",
    description: "需要 Google 服务账号密钥 json 文件",
    checked: false,
  },
];

// 兼容别名与导出
export type CanonicalSkillItem = CanonicalSkill;
export type CanonicalMcpItem = CanonicalMcpServer;
export const CANONICAL_MCPS = CANONICAL_MCP_SERVERS;

export const CANONICAL_USAGE_SUMMARY = {
  windowTitle: "最近 7 天总计",
  totalTokensText: "1,578 万 词元",
  weekOverWeek: "+8%",
  costEstimateYuan: "123.16",
  totalSessions: 127,
  sessionsCount: 127,
  cacheHitRate: "62%",
  cacheHitRatio: "62%",
  conversationsCount: 127,
};

export const CANONICAL_PROMPT_MANAGED_PREVIEW = `<!-- chimera:managed begin -->
## 严格代码审计与防御性编程
- 执行安全边界防泄漏审查
- CAS 写入校验
- 跨平台路径注入拦截
<!-- chimera:managed end -->`;

export interface DailyUsageSegment {
  value: number;
  color: string;
  providerName: string;
}

export interface DailyUsageStack {
  date: string;
  dayName?: string;
  isToday?: boolean;
  total: number;
  deepseek: number;
  official: number;
  kimi: number;
  zhipu: number;
  aliyun: number;
  openrouter: number;
  segments: DailyUsageSegment[];
}

export const CANONICAL_DAILY_STACKS: DailyUsageStack[] = [
  {
    date: "周一 21",
    total: 142,
    deepseek: 90,
    official: 0,
    kimi: 30,
    zhipu: 0,
    aliyun: 22,
    openrouter: 0,
    segments: [
      { providerName: "DeepSeek", value: 90, color: "#537197" },
      { providerName: "Kimi", value: 30, color: "#776894" },
      { providerName: "阿里云百炼", value: 22, color: "#61774B" },
    ],
  },
  {
    date: "周二 22",
    total: 198,
    deepseek: 158,
    official: 0,
    kimi: 0,
    zhipu: 40,
    aliyun: 0,
    openrouter: 0,
    segments: [
      { providerName: "DeepSeek", value: 158, color: "#537197" },
      { providerName: "智谱 GLM", value: 40, color: "#0D9488" },
    ],
  },
  {
    date: "周三 23",
    total: 176,
    deepseek: 122,
    official: 0,
    kimi: 0,
    zhipu: 38,
    aliyun: 0,
    openrouter: 16,
    segments: [
      { providerName: "DeepSeek", value: 122, color: "#537197" },
      { providerName: "智谱 GLM", value: 38, color: "#0D9488" },
      { providerName: "OpenRouter", value: 16, color: "#8F607A" },
    ],
  },
  {
    date: "周四 24",
    total: 231,
    deepseek: 149,
    official: 0,
    kimi: 47,
    zhipu: 0,
    aliyun: 35,
    openrouter: 0,
    segments: [
      { providerName: "DeepSeek", value: 149, color: "#537197" },
      { providerName: "Kimi", value: 47, color: "#776894" },
      { providerName: "阿里云百炼", value: 35, color: "#61774B" },
    ],
  },
  {
    date: "周五 25",
    total: 188,
    deepseek: 134,
    official: 0,
    kimi: 0,
    zhipu: 32,
    aliyun: 22,
    openrouter: 0,
    segments: [
      { providerName: "DeepSeek", value: 134, color: "#537197" },
      { providerName: "智谱 GLM", value: 32, color: "#0D9488" },
      { providerName: "阿里云百炼", value: 22, color: "#61774B" },
    ],
  },
  {
    date: "周六 26",
    total: 296,
    deepseek: 88,
    official: 208,
    kimi: 0,
    zhipu: 0,
    aliyun: 0,
    openrouter: 0,
    segments: [
      { providerName: "主力", value: 208, color: "#1A1E24" },
      { providerName: "DeepSeek", value: 88, color: "#537197" },
    ],
  },
  {
    date: "周日 27",
    isToday: true,
    total: 347,
    deepseek: 0,
    official: 186,
    kimi: 97,
    zhipu: 0,
    aliyun: 0,
    openrouter: 64,
    segments: [
      { providerName: "主力", value: 186, color: "#1A1E24" },
      { providerName: "Kimi", value: 97, color: "#776894" },
      { providerName: "OpenRouter", value: 64, color: "#8F607A" },
    ],
  },
];

export const CANONICAL_DAILY_TABLE_ROWS = CANONICAL_DAILY_STACKS;

export interface CanonicalModelUsageItem {
  id: string;
  providerName: string;
  defaultModel: string;
  tokensTenThousand: number;
  percentage: number;
  color: string;
}

export const CANONICAL_MODEL_USAGE: CanonicalModelUsageItem[] = [
  {
    id: "m-1",
    providerName: "DeepSeek",
    defaultModel: "deepseek-v4-pro",
    tokensTenThousand: 741,
    percentage: 47,
    color: "#537197",
  },
  {
    id: "m-2",
    providerName: "主力",
    defaultModel: "gpt-5.5",
    tokensTenThousand: 394,
    percentage: 25,
    color: "#1A1E24",
  },
  {
    id: "m-3",
    providerName: "Kimi",
    defaultModel: "kimi-k2.5",
    tokensTenThousand: 174,
    percentage: 11,
    color: "#776894",
  },
  {
    id: "m-4",
    providerName: "智谱 GLM",
    defaultModel: "glm-4.6",
    tokensTenThousand: 110,
    percentage: 7,
    color: "#0D9488",
  },
  {
    id: "m-5",
    providerName: "阿里云百炼",
    defaultModel: "qwen3-coder-plus",
    tokensTenThousand: 79,
    percentage: 5,
    color: "#61774B",
  },
  {
    id: "m-6",
    providerName: "OpenRouter",
    defaultModel: "openai/gpt-5.6",
    tokensTenThousand: 80,
    percentage: 5,
    color: "#8F607A",
  },
];

export interface ConversationUsageItem {
  id: string;
  title: string;
  note?: string;
  providerShort: string;
  providerBadgeBg: string;
  tokensText: string;
  costText: string;
  subAgents?: { id: string; title: string }[];
}

export const CANONICAL_CONVERSATION_USAGE: ConversationUsageItem[] = [
  {
    id: "conv-01",
    title: "拆分用量汇总里的子代理归属",
    note: "昨天 21:12 · 主力",
    providerShort: "主",
    providerBadgeBg: "#1A1E24",
    tokensText: "208 万",
    costText: "订阅内",
    subAgents: [
      { id: "sub-1", title: "Reviewer Subagent (140 万)" },
      { id: "sub-2", title: "Coder Subagent (68 万)" },
    ],
  },
  {
    id: "conv-02",
    title: "修复 config.toml 迁移时丢失 profile 的问题",
    note: "今天 14:20 · 主力",
    providerShort: "主",
    providerBadgeBg: "#1A1E24",
    tokensText: "186 万",
    costText: "订阅内",
    subAgents: [
      { id: "sub-3", title: "Planner Subagent (98 万)" },
      { id: "sub-4", title: "Executor Subagent (88 万)" },
    ],
  },
  {
    id: "conv-03",
    title: "为线路列表加上键盘上下选择",
    note: "今天 11:05 · Kimi",
    providerShort: "Ki",
    providerBadgeBg: "#776894",
    tokensText: "97 万",
    costText: "¥ 4.85",
  },
  {
    id: "conv-04",
    title: "把 cc-switch 导入改成四类结果",
    note: "昨天 16:30 · DeepSeek",
    providerShort: "DS",
    providerBadgeBg: "#537197",
    tokensText: "88 万",
    costText: "¥ 10.56",
  },
  {
    id: "conv-05",
    title: "排查 OpenRouter 返回 429 的重试间隔",
    note: "今天 09:40 · OpenRouter",
    providerShort: "OR",
    providerBadgeBg: "#8F607A",
    tokensText: "64 万",
    costText: "¥ 9.60",
  },
];

export type HealthDiagnosticItem = CanonicalHealthItem;
export const CANONICAL_HEALTH_DIAGNOSTICS = CANONICAL_HEALTH_ITEMS;

export interface AuthWriteHistoryItem {
  id: string;
  time: string;
  accountWritten: string;
  triggerPath?: string;
  backupRef?: string;
  note?: string;
}

export const CANONICAL_AUTH_WRITE_HISTORY: AuthWriteHistoryItem[] = [
  {
    id: "h-1",
    time: "今天 14:20",
    accountWritten: "OpenAI 官方 · 主力",
    triggerPath: "切换到官方账号时写入",
    backupRef: "备份 #0412",
    note: "切换到官方账号时写入",
  },
  {
    id: "h-2",
    time: "昨天 19:52",
    accountWritten: "OpenAI 官方 · 工作",
    triggerPath: "切换账号时写入",
    backupRef: "备份 #0409",
    note: "切换账号时写入",
  },
];

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
