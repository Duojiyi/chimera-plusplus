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

export type ToolProviderFields = {
  baseUrl: string;
  apiKey: string;
  model: string;
  nativeProtocol: string;
  anthropicAuthField: ClaudeApiKeyField;
};

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
  const common = { nativeProtocol: "", anthropicAuthField };
  switch (appId) {
    case "claude":
      return {
        ...common,
        baseUrl: text(env.ANTHROPIC_BASE_URL),
        apiKey: text(env[anthropicAuthField]),
        model: text(env.ANTHROPIC_MODEL),
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
    const values =
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
  openclaw: "OpenClaw",
  hermes: "Hermes",
  mcode: "MiniMax Code",
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
  if (appId === "mcode")
    return {
      baseUrl: text(object(settings.options).baseURL),
      model: Object.keys(object(settings.models))[0] ?? "",
    };
  if (appId === "hermes")
    return {
      baseUrl: text(settings.base_url),
      model: Array.isArray(settings.models)
        ? text(object(settings.models[0]).id)
        : (Object.keys(object(settings.models))[0] ?? ""),
    };
  if (appId === "claude-desktop")
    return {
      baseUrl:
        text(settings.baseUrl) || text(object(settings.env).ANTHROPIC_BASE_URL),
      model:
        Object.values(provider.meta?.claudeDesktopModelRoutes ?? {})[0]
          ?.model ?? "",
    };
  if (appId !== "openclaw") throw new Error(`Unsupported tool: ${appId}`);
  const first = object(
    Array.isArray(settings.models) ? settings.models[0] : undefined,
  );
  return { baseUrl: text(settings.baseUrl), model: text(first.id) };
}
