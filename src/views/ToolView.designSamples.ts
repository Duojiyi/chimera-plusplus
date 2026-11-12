import type { Provider } from "@/types";
import type { AppId } from "@/lib/api/types";
import type {
  ClaudeBinding,
  ClaudeCodeAccount,
  ClaudeCodeAccounts,
  ClaudeDesktopSwapStatus,
  ClaudeQuota,
} from "@/lib/api/claudeAccounts";
import type { PiDocument } from "@/lib/api/pi";

/**
 * Browser design-preview fixtures for the tool pages (L14, L15, L24, L30–L33).
 *
 * Only used when the renderer runs outside Tauri with `?preview=design`, so
 * the layout can be reviewed without a backend. Every write stays disabled
 * while these are on screen. Accounts use the example domains of the design
 * boards; model names follow the shared fake-data baseline (design §6).
 */
export const isToolDesignPreview = (): boolean =>
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  !("__TAURI_INTERNALS__" in window) &&
  new URLSearchParams(window.location.search).get("preview") === "design";

const line = (
  id: string,
  name: string,
  settingsConfig: Record<string, unknown>,
  extra: Partial<Provider> = {},
): Provider => ({ id, name, settingsConfig, ...extra });

const grokToml = (model: string, baseUrl: string) =>
  [
    "[models]",
    `default = "${model}"`,
    "",
    `[model."${model}"]`,
    `model = "${model}"`,
    `base_url = "${baseUrl}"`,
    "context_window = 256000",
  ].join("\n");

/** Saved lines per tool, plus the id of the line in use. */
export const TOOL_SAMPLE_LINES: Partial<
  Record<AppId, { lines: Provider[]; current: string }>
> = {
  claude: {
    current: "cc-official",
    lines: [
      line("cc-official", "Claude 官方", { env: {} }, { category: "official" }),
      line(
        "cc-relay",
        "自建中转",
        {
          env: {
            ANTHROPIC_BASE_URL: "https://relay.studio.dev",
            ANTHROPIC_MODEL: "claude-sonnet-4-6",
          },
        },
        { iconColor: "#776894", sortIndex: 1 },
      ),
      line(
        "cc-kimi",
        "Kimi 兼容",
        {
          env: {
            ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
            ANTHROPIC_MODEL: "kimi-k2",
          },
        },
        { iconColor: "#8f6446", sortIndex: 2 },
      ),
    ],
  },
  "claude-desktop": {
    current: "cd-official",
    lines: [
      line("cd-official", "Claude 官方", { env: {} }, { category: "official" }),
      line(
        "cd-relay",
        "自建中转",
        { baseUrl: "https://relay.studio.dev" },
        {
          iconColor: "#776894",
          meta: {
            claudeDesktopModelRoutes: {
              sonnet: { model: "claude-sonnet-4-6" },
            },
          } as Provider["meta"],
        },
      ),
    ],
  },
  gemini: {
    current: "gm-official",
    lines: [
      line(
        "gm-official",
        "Google 官方",
        { env: { GEMINI_MODEL: "gemini-2.5-pro" } },
        { category: "official" },
      ),
      line(
        "gm-relay",
        "自建中转",
        {
          env: {
            GOOGLE_GEMINI_BASE_URL: "https://relay.studio.dev/gemini",
            GEMINI_MODEL: "gemini-2.5-pro",
          },
        },
        { iconColor: "#8f607a", sortIndex: 1 },
      ),
    ],
  },
  grokbuild: {
    current: "gk-official",
    lines: [
      line(
        "gk-official",
        "xAI 官方",
        { config: grokToml("grok-4", "https://api.x.ai/v1") },
        { category: "official" },
      ),
      line(
        "gk-relay",
        "API 中转",
        { config: grokToml("grok-4", "https://relay.studio.dev/xai") },
        { iconColor: "#8f6446", sortIndex: 1 },
      ),
    ],
  },
  opencode: {
    current: "",
    lines: [
      line(
        "oc-anthropic",
        "Anthropic",
        {
          npm: "@ai-sdk/anthropic",
          options: { baseURL: "https://api.anthropic.com/v1" },
          models: { "claude-sonnet-4-6": {} },
        },
        { meta: { liveConfigManaged: true }, iconColor: "#357b7f" },
      ),
      line(
        "oc-deepseek",
        "DeepSeek",
        {
          options: { baseURL: "https://api.deepseek.com/v1" },
          models: { "deepseek-v4-pro": {} },
        },
        {
          meta: { liveConfigManaged: true },
          iconColor: "#537197",
          sortIndex: 1,
        },
      ),
      line(
        "oc-qwen",
        "通义千问",
        {
          options: { baseURL: "https://dashscope.aliyuncs.com/v1" },
          models: { "qwen3-coder-plus": {} },
        },
        {
          meta: { liveConfigManaged: false },
          iconColor: "#8f6446",
          sortIndex: 2,
        },
      ),
    ],
  },
  pi: {
    current: "",
    lines: [
      line(
        "pi-anthropic",
        "anthropic",
        {
          api: "anthropic-messages",
          models: [
            { id: "claude-sonnet-4-6", baseUrl: "https://api.anthropic.com" },
          ],
        },
        { meta: { liveConfigManaged: true }, iconColor: "#357b7f" },
      ),
      line(
        "pi-relay",
        "studio-relay",
        {
          models: [{ id: "gpt-5.5", baseUrl: "https://relay.studio.dev/v1" }],
        },
        {
          meta: { liveConfigManaged: true },
          iconColor: "#776894",
          sortIndex: 1,
        },
      ),
      line(
        "pi-glm",
        "zhipu",
        {
          models: [
            { id: "glm-5", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
          ],
        },
        {
          meta: { liveConfigManaged: false },
          iconColor: "#61774b",
          sortIndex: 2,
        },
      ),
    ],
  },
};

/** Where each tool keeps its configuration, as the desktop app would report. */
export const TOOL_SAMPLE_CONFIG_DIR: Partial<Record<AppId, string>> = {
  claude: "~/.claude",
  "claude-desktop": "%APPDATA%\\Claude",
  gemini: "~/.gemini",
  grokbuild: "~/.grok",
  opencode: "~/.config/opencode",
  pi: "~/.pi/agent",
};

const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

const quota = (weekly: number, resetHours: number): ClaudeQuota => ({
  status: "fresh",
  windows: [
    {
      name: "seven_day",
      label: "本周额度",
      kind: "weekly",
      utilization: weekly,
      resetsAt: hours(resetHours),
      reset: false,
    },
  ],
  extraUsage: null,
  fetchedAt: Date.now() - 12 * 60_000,
});

const account = (
  id: string,
  email: string,
  plan: string,
  over: Partial<ClaudeCodeAccount> = {},
): ClaudeCodeAccount => ({
  id,
  name: email,
  email,
  plan,
  fingerprint: null,
  createdAt: "2026-10-02T09:00:00Z",
  updatedAt: "2026-11-11T09:00:00Z",
  isCurrent: false,
  needsRelogin: false,
  unreadable: false,
  kind: "oauth",
  disabled: false,
  sessionRunning: false,
  note: null,
  ...over,
});

export const CLAUDE_SAMPLE_ACCOUNTS: ClaudeCodeAccounts = {
  supported: true,
  unsupportedReason: null,
  browserLoginSupported: true,
  sessionsSupported: true,
  live: {
    signedIn: true,
    email: "me@studio.dev",
    plan: "Claude Max 20x",
    savedId: "acc-me",
  },
  liveError: null,
  accounts: [
    account("acc-me", "me@studio.dev", "Claude Max 20x", {
      isCurrent: true,
      note: "主力",
    }),
    account("acc-work", "work@company.com", "Claude Pro", { note: "工作" }),
    account("acc-old", "old@gmail.com", "Claude Free", {
      needsRelogin: true,
      note: "归档",
    }),
  ],
};

export const CLAUDE_SAMPLE_QUOTA: Record<string, ClaudeQuota> = {
  "acc-me": quota(38, 4 * 24 + 2),
  "acc-work": quota(81, 30),
  "acc-old": { ...quota(0, 0), status: "needs_relogin", windows: [] },
};

export const CLAUDE_DESKTOP_SAMPLE_ACCOUNTS: ClaudeCodeAccounts = {
  ...CLAUDE_SAMPLE_ACCOUNTS,
  live: { signedIn: true, email: "lin@studio.dev", plan: "Claude Max 20x" },
  accounts: [
    account("acc-lin", "lin@studio.dev", "Claude Max 20x"),
    account("acc-ops", "ops@studio.dev", "Claude Pro"),
  ],
};

export const CLAUDE_DESKTOP_SAMPLE_QUOTA: Record<string, ClaudeQuota> = {
  "acc-lin": quota(34, 3 * 24),
  "acc-ops": quota(71, 50),
};

export const CLAUDE_DESKTOP_SAMPLE_SWAP: ClaudeDesktopSwapStatus = {
  supported: true,
  running: true,
  signedIn: true,
  currentAccountId: "acc-lin",
  snapshots: [
    {
      accountId: "acc-lin",
      capturedAt: "2026-11-09T21:40:00Z",
      isCurrent: true,
    },
    {
      accountId: "acc-ops",
      capturedAt: "2026-11-05T16:02:00Z",
      isCurrent: false,
    },
  ],
};

export const CLAUDE_SAMPLE_BINDINGS: ClaudeBinding[] = [
  {
    path: "D:\\work\\company-api",
    accountId: "acc-work",
    accountName: "work@company.com",
    accountEmail: "work@company.com",
    state: "ready",
    pathMissing: false,
  },
  {
    path: "D:\\studio\\site",
    accountId: "acc-me",
    accountName: "me@studio.dev",
    accountEmail: "me@studio.dev",
    state: "ready",
    pathMissing: false,
  },
];

export const OMP_SAMPLE_DOCUMENT: PiDocument = {
  path: "~/.omp/agent/models.yml",
  revision: "preview",
  value: {
    providers: {
      "anthropic-official": {
        baseUrl: "https://api.anthropic.com",
        api: "anthropic-messages",
        models: [{ id: "claude-sonnet-4-6" }],
      },
      "studio-relay": {
        baseUrl: "https://relay.studio.dev/v1",
        api: "openai-completions",
        models: [{ id: "claude-sonnet-4-6" }, { id: "gpt-5.5" }],
      },
      "bedrock-backup": {
        api: "bedrock-converse-stream",
        models: [{ id: "claude-sonnet-4-6" }],
      },
    },
  },
};
