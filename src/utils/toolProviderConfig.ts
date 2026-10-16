import { parseGrokBuildConfig } from "@/utils/grokBuildConfig";
import type { AppId } from "@/lib/api/types";
import type { ClaudeApiKeyField, Provider } from "@/types";

export type NativeToolAppId = Extract<
  AppId,
  "claude" | "gemini" | "opencode" | "pi"
>;

export const nativeToolNames: Record<NativeToolAppId, string> = {
  claude: "Claude Code",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  pi: "Pi",
};

export function isNativeToolAppId(appId: AppId): appId is NativeToolAppId {
  return Object.hasOwn(nativeToolNames, appId);
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * Claude Code's model tiers. Each maps to `ANTHROPIC_DEFAULT_<TIER>_MODEL`,
 * with an optional `…_MODEL_NAME` that Claude Code's model menu shows.
 */
export const CLAUDE_MODEL_TIERS = [
  ["haiku", "Haiku"],
  ["sonnet", "Sonnet"],
  ["opus", "Opus"],
  ["fable", "Fable"],
] as const;

export type ClaudeModelTier = (typeof CLAUDE_MODEL_TIERS)[number][0];
export type ClaudeTierModels = Record<
  ClaudeModelTier,
  { model: string; name: string }
>;

/** The tiers in the order the line editors list them (Claude Desktop's). */
export const CLAUDE_TIER_ROWS: readonly ClaudeModelTier[] = [
  "sonnet",
  "opus",
  "fable",
  "haiku",
];

/**
 * Claude Code's 1M context declaration: a `[1M]` suffix on a model ID, in any
 * case. Claude Code strips it before the request and gives the model a 1M
 * window. Drafts keep the stored value as it is; the editor shows the bare ID
 * with a 1M checkbox.
 */
export const CLAUDE_ONE_M_MARKER = "[1M]";

export function hasClaudeOneMMarker(model: string): boolean {
  return model.trimEnd().toLowerCase().endsWith("[1m]");
}

export function stripClaudeOneMMarker(model: string): string {
  const trimmedEnd = model.trimEnd();
  if (!trimmedEnd.toLowerCase().endsWith("[1m]")) return model;
  return trimmedEnd.slice(0, -CLAUDE_ONE_M_MARKER.length).trimEnd();
}

export function setClaudeOneMMarker(model: string, enabled: boolean): string {
  const base = stripClaudeOneMMarker(model).trim();
  if (!base) return "";
  return enabled ? `${base}${CLAUDE_ONE_M_MARKER}` : base;
}

const claudeTierKey = (tier: ClaudeModelTier) =>
  `ANTHROPIC_DEFAULT_${tier.toUpperCase()}_MODEL`;

const claudeTiers = (env: Record<string, unknown>): ClaudeTierModels =>
  Object.fromEntries(
    CLAUDE_MODEL_TIERS.map(([tier]) => [
      tier,
      {
        model: text(env[claudeTierKey(tier)]),
        name: text(env[`${claudeTierKey(tier)}_NAME`]),
      },
    ]),
  ) as ClaudeTierModels;

export const emptyClaudeTiers = () => claudeTiers({});

/**
 * Tiers the backend fills with the default model whenever they are empty:
 * every save runs `normalize_claude_models_in_value`, so that Claude Code
 * talking to a relay directly never asks for a model the relay lacks.
 */
export const CLAUDE_TIERS_FOLLOWING_DEFAULT: readonly ClaudeModelTier[] = [
  "haiku",
  "sonnet",
  "opus",
];

/**
 * The tiers as the editor shows them. One that equals the default model and
 * has no menu name is how the backend stores "follow the default", so it
 * shows empty and saving it empty lets the backend fill in the current
 * default again. A legacy `ANTHROPIC_SMALL_FAST_MODEL` is the Haiku tier,
 * which is what saving turns it into.
 */
function readClaudeTiers(env: Record<string, unknown>): ClaudeTierModels {
  const tiers = claudeTiers(env);
  if (!tiers.haiku.model) {
    tiers.haiku = {
      ...tiers.haiku,
      model: text(env.ANTHROPIC_SMALL_FAST_MODEL),
    };
  }
  const model = text(env.ANTHROPIC_MODEL).trim();
  for (const tier of CLAUDE_TIERS_FOLLOWING_DEFAULT) {
    const slot = tiers[tier];
    if (model && slot.model.trim() === model && !slot.name.trim()) {
      tiers[tier] = { model: "", name: "" };
    }
  }
  return tiers;
}

export type ToolProviderFields = {
  baseUrl: string;
  apiKey: string;
  model: string;
  nativeProtocol: string;
  anthropicAuthField: ClaudeApiKeyField;
  /** Claude Code only: the upstream model and menu name of each tier. */
  claudeTiers: ClaudeTierModels;
  /** Claude Code only: `CLAUDE_CODE_SUBAGENT_MODEL`. */
  subagentModel: string;
};

/** A Claude Code model field the fetched model list can fill. */
export type ClaudeModelField = "default" | ClaudeModelTier | "subagent";

type ClaudeModelFields = Pick<
  ToolProviderFields,
  "model" | "claudeTiers" | "subagentModel"
>;

export function claudeTierLabel(tier: ClaudeModelTier): string {
  return CLAUDE_MODEL_TIERS.find(([id]) => id === tier)?.[1] ?? tier;
}

export function claudeModelFieldLabel(field: ClaudeModelField): string {
  if (field === "default") return "默认模型";
  if (field === "subagent") return "子代理模型";
  return `${claudeTierLabel(field)} 模型`;
}

function storedClaudeModel(
  fields: ClaudeModelFields,
  field: ClaudeModelField,
): string {
  if (field === "default") return fields.model;
  if (field === "subagent") return fields.subagentModel;
  return fields.claudeTiers[field].model;
}

function withStoredClaudeModel<T extends ClaudeModelFields>(
  fields: T,
  field: ClaudeModelField,
  model: string,
): T {
  if (field === "default") return { ...fields, model };
  if (field === "subagent") return { ...fields, subagentModel: model };
  return {
    ...fields,
    claudeTiers: {
      ...fields.claudeTiers,
      [field]: { ...fields.claudeTiers[field], model },
    },
  };
}

/** The model ID of one field without its 1M marker, as the inputs and the
 * model picker (and its 当前 tag) show it. */
export function claudeModelValue(
  fields: ClaudeModelFields,
  field: ClaudeModelField,
): string {
  return stripClaudeOneMMarker(storedClaudeModel(fields, field));
}

/** Whether one field declares 1M context. */
export function claudeModelOneM(
  fields: ClaudeModelFields,
  field: ClaudeModelField,
): boolean {
  return hasClaudeOneMMarker(storedClaudeModel(fields, field));
}

/** The same fields with one model replaced. Its 1M declaration stays; a model
 * typed or picked with the marker turns it on. */
export function withClaudeModel<T extends ClaudeModelFields>(
  fields: T,
  field: ClaudeModelField,
  model: string,
): T {
  const oneM =
    hasClaudeOneMMarker(storedClaudeModel(fields, field)) ||
    hasClaudeOneMMarker(model);
  return withStoredClaudeModel(
    fields,
    field,
    oneM ? setClaudeOneMMarker(model, true) : model,
  );
}

/** The same fields with one model's 1M declaration set or cleared. */
export function withClaudeOneM<T extends ClaudeModelFields>(
  fields: T,
  field: ClaudeModelField,
  enabled: boolean,
): T {
  return withStoredClaudeModel(
    fields,
    field,
    setClaudeOneMMarker(storedClaudeModel(fields, field), enabled),
  );
}

/** Read the same native shape we write; never fall back to a Codex template. */
export function toolProviderFields(
  appId: NativeToolAppId,
  provider?: Provider | null,
): ToolProviderFields {
  const settings = object(provider?.settingsConfig);
  const env = object(settings.env);
  const anthropicAuthField: ClaudeApiKeyField =
    typeof env.ANTHROPIC_AUTH_TOKEN === "string"
      ? "ANTHROPIC_AUTH_TOKEN"
      : typeof env.ANTHROPIC_API_KEY === "string"
        ? "ANTHROPIC_API_KEY"
        : "ANTHROPIC_AUTH_TOKEN";
  const common = {
    nativeProtocol: "",
    anthropicAuthField,
    claudeTiers: claudeTiers({}),
    subagentModel: "",
  };
  switch (appId) {
    case "claude":
      return {
        ...common,
        baseUrl: text(env.ANTHROPIC_BASE_URL),
        apiKey: text(env[anthropicAuthField]),
        model: text(env.ANTHROPIC_MODEL),
        claudeTiers: readClaudeTiers(env),
        subagentModel: text(env.CLAUDE_CODE_SUBAGENT_MODEL),
      };
    case "gemini":
      return {
        ...common,
        baseUrl: text(env.GOOGLE_GEMINI_BASE_URL),
        apiKey: text(env.GEMINI_API_KEY),
        model: text(env.GEMINI_MODEL),
      };
    case "opencode": {
      const options = object(settings.options);
      return {
        ...common,
        nativeProtocol: text(settings.npm) || "@ai-sdk/openai-compatible",
        baseUrl: text(options.baseURL),
        apiKey: text(options.apiKey),
        model: Object.keys(object(settings.models))[0] ?? "",
      };
    }
    case "pi": {
      const first = object(
        Array.isArray(settings.models) ? settings.models[0] : undefined,
      );
      return {
        ...common,
        nativeProtocol:
          text(first.api) || text(settings.api) || "openai-completions",
        baseUrl: text(first.baseUrl) || text(settings.baseUrl),
        apiKey: text(settings.apiKey),
        model: text(first.id),
      };
    }
  }
}

/** Change the exposed fields only, retaining other models and native settings. */
export function updateToolProviderConfig(
  appId: NativeToolAppId,
  provider: Provider | null,
  fields: ToolProviderFields,
): Record<string, unknown> {
  const settings = { ...object(provider?.settingsConfig) };
  const baseUrl = fields.baseUrl.trim();
  const apiKey = fields.apiKey.trim();
  const model = fields.model.trim();
  if (appId === "claude" || appId === "gemini") {
    const env = { ...object(settings.env) };
    const values: Record<string, string> =
      appId === "claude"
        ? {
            ANTHROPIC_BASE_URL: baseUrl,
            [fields.anthropicAuthField]: apiKey,
            ANTHROPIC_MODEL: model,
          }
        : {
            GOOGLE_GEMINI_BASE_URL: baseUrl,
            GEMINI_API_KEY: apiKey,
            GEMINI_MODEL: model,
          };
    if (appId === "claude") {
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      // The Haiku row shows and replaces the legacy small/fast model.
      delete env.ANTHROPIC_SMALL_FAST_MODEL;
      for (const [tier] of CLAUDE_MODEL_TIERS) {
        const key = claudeTierKey(tier);
        const tierModel = fields.claudeTiers[tier].model.trim();
        values[key] = tierModel;
        // A menu name without a model would name nothing.
        values[`${key}_NAME`] = tierModel
          ? fields.claudeTiers[tier].name.trim()
          : "";
      }
      values.CLAUDE_CODE_SUBAGENT_MODEL = fields.subagentModel.trim();
    }
    for (const [key, value] of Object.entries(values)) {
      if (value) env[key] = value;
      else delete env[key];
    }
    return { ...settings, env };
  }
  if (appId === "opencode") {
    const models = { ...object(settings.models) };
    const first = Object.keys(models)[0];
    const modelSettings = object(
      models[model] ?? (first ? models[first] : undefined),
    );
    if (first && first !== model) delete models[first];
    return {
      ...settings,
      npm: fields.nativeProtocol,
      options: { ...object(settings.options), baseURL: baseUrl, apiKey },
      models: { [model]: modelSettings, ...models },
    };
  }
  if (appId !== "pi") throw new Error(`Unsupported native tool: ${appId}`);
  const models = Array.isArray(settings.models) ? [...settings.models] : [];
  const first = object(models[0]);
  models[0] = {
    ...first,
    id: model,
    ...(typeof first.baseUrl === "string" ? { baseUrl } : {}),
    ...(typeof first.api === "string" ? { api: fields.nativeProtocol } : {}),
  };
  return { ...settings, baseUrl, apiKey, api: fields.nativeProtocol, models };
}

export const additionalToolNames = {
  "claude-desktop": "Claude Desktop",
  grokbuild: "Grok Build",
} as const;
export type AdditionalToolAppId = keyof typeof additionalToolNames;

/** Summary only: additional tools are edited by their existing native forms. */
export function toolProviderSummary(
  appId: Exclude<AppId, "codex">,
  provider: Provider,
) {
  if (isNativeToolAppId(appId)) return toolProviderFields(appId, provider);
  const settings = object(provider.settingsConfig);
  if (appId === "grokbuild") return parseGrokBuildConfig(text(settings.config));
  if (appId === "claude-desktop")
    return {
      baseUrl:
        text(settings.baseUrl) || text(object(settings.env).ANTHROPIC_BASE_URL),
      model:
        Object.values(provider.meta?.claudeDesktopModelRoutes ?? {})[0]
          ?.model ?? "",
    };
  throw new Error(`Unsupported tool: ${appId}`);
}
