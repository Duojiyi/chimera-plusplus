import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { Provider } from "@/types";
import type { AdditionalToolAppId } from "@/utils/toolProviderConfig";
import { additionalToolNames } from "@/utils/toolProviderConfig";
import type { ProviderFormValues } from "./ProviderForm";

export type GenericToolAppId = Exclude<
  AdditionalToolAppId,
  "claude-desktop" | "grokbuild"
>;

export function isGenericToolAppId(
  appId: AdditionalToolAppId,
): appId is GenericToolAppId {
  return appId !== "claude-desktop" && appId !== "grokbuild";
}

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asText = (value: unknown): string =>
  typeof value === "string" ? value : "";

const asPositiveInt = (value: unknown, fallback: number): number => {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isInteger(num) && num > 0 ? num : fallback;
};

const PROTOCOL_OPTIONS: Partial<
  Record<GenericToolAppId, readonly { value: string; label: string }[]>
> = {
  kimi: [
    { value: "kimi", label: "Kimi (OpenAI 兼容)" },
    { value: "openai", label: "OpenAI Chat Completions" },
    { value: "openai_responses", label: "OpenAI Responses" },
    { value: "anthropic", label: "Anthropic Messages" },
    { value: "google-genai", label: "Google GenAI" },
    { value: "vertexai", label: "Vertex AI" },
  ],
  dsh: [
    { value: "openai-completions", label: "OpenAI Completions" },
    { value: "openai-responses", label: "OpenAI Responses" },
    { value: "anthropic-messages", label: "Anthropic Messages" },
  ],
  mcode: [
    { value: "anthropic-messages", label: "Anthropic Messages" },
    { value: "openai-completions", label: "OpenAI Completions" },
    { value: "openai-responses", label: "OpenAI Responses" },
  ],
};

interface ExtractedFields {
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol: string;
  maxContextSize: number;
}

function extractFields(
  appId: GenericToolAppId,
  settings: Record<string, unknown>,
  fallbackId?: string,
): ExtractedFields {
  const baseDefault = { protocol: "", maxContextSize: 131072 };
  switch (appId) {
    case "agy": {
      const env = asObject(settings.env);
      const modelObj = asObject(asObject(settings.config).model);
      return {
        ...baseDefault,
        baseUrl: asText(env.GOOGLE_GEMINI_BASE_URL),
        apiKey: asText(env.GEMINI_API_KEY),
        model: asText(modelObj.name) || asText(env.GEMINI_MODEL),
      };
    }
    case "openclaw": {
      const first = asObject(
        Array.isArray(settings.models) ? settings.models[0] : undefined,
      );
      return {
        ...baseDefault,
        baseUrl: asText(settings.baseUrl),
        apiKey: asText(settings.apiKey),
        model: asText(first.id) || asText(settings.model),
      };
    }
    case "hermes": {
      const firstModel = Array.isArray(settings.models)
        ? asText(asObject(settings.models[0]).id)
        : (Object.keys(asObject(settings.models))[0] ?? "");
      return {
        ...baseDefault,
        baseUrl: asText(settings.base_url),
        apiKey: asText(settings.api_key),
        model: firstModel || asText(settings.model),
      };
    }
    case "mcode":
    case "dsh": {
      const options = asObject(settings.options);
      const defaultApi =
        appId === "mcode" ? "anthropic-messages" : "openai-completions";
      return {
        ...baseDefault,
        baseUrl: asText(options.baseURL),
        apiKey: asText(options.apiKey),
        model: Object.keys(asObject(settings.models))[0] ?? "",
        protocol: asText(settings.api) || defaultApi,
      };
    }
    case "kimi": {
      const p = asObject(settings.provider);
      const modelsObj = asObject(settings.models);
      const firstKey = Object.keys(modelsObj)[0] ?? "";
      const firstModelObj = asObject(modelsObj[firstKey]);
      return {
        baseUrl: asText(p.base_url),
        apiKey: asText(p.api_key),
        model: asText(firstModelObj.model) || firstKey,
        protocol: asText(p.type) || "openai",
        maxContextSize: asPositiveInt(firstModelObj.max_context_size, 131072),
      };
    }
    case "copilot": {
      const p = asObject(settings.provider);
      const first = asObject(
        Array.isArray(settings.models) ? settings.models[0] : undefined,
      );
      return {
        ...baseDefault,
        baseUrl: asText(p.baseUrl),
        apiKey: asText(p.apiKey),
        model: asText(first.id),
      };
    }
    case "workbuddy": {
      const first = asObject(
        Array.isArray(settings.models) ? settings.models[0] : undefined,
      );
      return {
        ...baseDefault,
        baseUrl: asText(settings.url) || asText(first.url),
        apiKey: asText(settings.apiKey) || asText(first.apiKey),
        model: asText(first.id) || asText(first.model),
      };
    }
    case "codebuddy": {
      return {
        ...baseDefault,
        baseUrl: asText(settings.url) || asText(settings.baseUrl),
        apiKey: asText(settings.apiKey),
        model: asText(settings.id) || fallbackId || "",
      };
    }
  }
}

function buildSettings(
  appId: GenericToolAppId,
  base: Record<string, unknown>,
  fields: ExtractedFields,
  providerMeta?: { key?: string; name?: string },
): Record<string, unknown> {
  const baseUrl = fields.baseUrl.trim();
  const apiKey = fields.apiKey.trim();
  const model = fields.model.trim();
  switch (appId) {
    case "agy": {
      const env = { ...asObject(base.env) };
      if (baseUrl) env.GOOGLE_GEMINI_BASE_URL = baseUrl;
      else delete env.GOOGLE_GEMINI_BASE_URL;
      if (apiKey) env.GEMINI_API_KEY = apiKey;
      else delete env.GEMINI_API_KEY;
      const config = { ...asObject(base.config) };
      if (model) {
        config.model = { ...asObject(config.model), name: model };
      } else {
        delete config.model;
      }
      return { ...base, env, config };
    }
    case "openclaw": {
      const models = Array.isArray(base.models) ? [...base.models] : [];
      if (model) {
        models[0] = { ...asObject(models[0]), id: model };
      }
      return {
        ...base,
        baseUrl,
        apiKey,
        api: asText(base.api) || "openai-completions",
        models,
      };
    }
    case "hermes": {
      // hermes_config.rs derives YAML `model:` from `models` and removes `model` if `models` is absent.
      const prevModels = Array.isArray(base.models) ? [...base.models] : [];
      const models = model
        ? [{ ...asObject(prevModels[0]), id: model }, ...prevModels.slice(1)]
        : prevModels;
      return {
        ...base,
        base_url: baseUrl,
        api_key: apiKey,
        models,
        ...(model ? { model } : {}),
      };
    }
    case "mcode":
    case "dsh": {
      const models = { ...asObject(base.models) };
      const firstKey = Object.keys(models)[0];
      if (model && firstKey && firstKey !== model) {
        const prev = models[firstKey];
        delete models[firstKey];
        models[model] = prev ?? {};
      } else if (model && !models[model]) {
        models[model] = {};
      }
      const defaultApi =
        appId === "mcode" ? "anthropic-messages" : "openai-completions";
      return {
        ...base,
        api: fields.protocol || asText(base.api) || defaultApi,
        options: { ...asObject(base.options), baseURL: baseUrl, apiKey },
        models,
      };
    }
    case "kimi": {
      const models = { ...asObject(base.models) };
      const firstKey = Object.keys(models)[0];
      const existingEntry = asObject(
        models[model] ?? (firstKey ? models[firstKey] : undefined),
      );
      if (model && firstKey && firstKey !== model) {
        delete models[firstKey];
      }
      if (model) {
        models[model] = {
          ...existingEntry,
          model,
          max_context_size: asPositiveInt(fields.maxContextSize, 131072),
          ...(providerMeta?.key ? { provider: providerMeta.key } : {}),
        };
      }
      return {
        ...base,
        provider: {
          ...asObject(base.provider),
          type:
            fields.protocol || asText(asObject(base.provider).type) || "openai",
          base_url: baseUrl,
          api_key: apiKey,
        },
        models,
      };
    }
    case "copilot": {
      const models = Array.isArray(base.models) ? [...base.models] : [];
      if (model) {
        models[0] = { ...asObject(models[0]), id: model };
      }
      return {
        ...base,
        provider: {
          ...asObject(base.provider),
          baseUrl,
          apiKey,
        },
        models,
      };
    }
    case "workbuddy": {
      const models = Array.isArray(base.models) ? [...base.models] : [];
      if (model) {
        models[0] = { ...asObject(models[0]), id: model };
      }
      return {
        ...base,
        url: baseUrl,
        apiKey,
        models,
      };
    }
    case "codebuddy": {
      // codebuddy_config.rs stores one flat entry per provider inside `~/.codebuddy/models.json`.
      const next: Record<string, unknown> = {
        ...base,
        url: baseUrl,
        apiKey,
      };
      delete next.models;
      if (model) {
        next.id = model;
      }
      if (providerMeta?.name?.trim()) {
        next.name = providerMeta.name.trim();
      }
      return next;
    }
  }
}

export interface GenericToolProviderFormProps {
  appId: GenericToolAppId;
  initialData?: Provider;
  onSubmit: (values: ProviderFormValues) => Promise<void> | void;
  onSubmittingChange?: (submitting: boolean) => void;
  onDirtyChange?: () => void;
  onNameChange?: (name: string) => void;
  onBaseUrlChange?: (url: string | null) => void;
  saveSummaryNote?: string;
}

export function GenericToolProviderForm({
  appId,
  initialData,
  onSubmit,
  onSubmittingChange,
  onDirtyChange,
  onNameChange,
  onBaseUrlChange,
  saveSummaryNote,
}: GenericToolProviderFormProps) {
  const initialSettings = asObject(initialData?.settingsConfig);
  const initialFields = extractFields(appId, initialSettings, initialData?.id);

  const [name, setName] = useState(initialData?.name ?? "");
  const [providerKey, setProviderKey] = useState(initialData?.id ?? "");
  const [baseUrl, setBaseUrl] = useState(initialFields.baseUrl);
  const [apiKey, setApiKey] = useState(initialFields.apiKey);
  const [model, setModel] = useState(initialFields.model);
  const [protocol, setProtocol] = useState(initialFields.protocol);
  const [maxContextSize, setMaxContextSize] = useState(
    initialFields.maxContextSize,
  );
  const [notes, setNotes] = useState(initialData?.notes ?? "");
  const [showKey, setShowKey] = useState(false);
  const [rawJson, setRawJson] = useState(() =>
    JSON.stringify(
      Object.keys(initialSettings).length > 0
        ? initialSettings
        : buildSettings(appId, {}, initialFields, {
            key: initialData?.id,
            name: initialData?.name,
          }),
      null,
      2,
    ),
  );
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const toolName = additionalToolNames[appId];
  const protocolOptions = PROTOCOL_OPTIONS[appId];

  useEffect(() => {
    onNameChange?.(name);
  }, [name, onNameChange]);

  useEffect(() => {
    onBaseUrlChange?.(baseUrl.trim() || null);
  }, [baseUrl, onBaseUrlChange]);

  const syncJsonFromFields = (
    next: ExtractedFields,
    meta?: { key?: string; name?: string },
  ) => {
    const resolvedMeta = {
      key: meta?.key ?? (providerKey.trim() || undefined),
      name: meta?.name ?? (name.trim() || undefined),
    };
    try {
      const parsed = asObject(JSON.parse(rawJson));
      setRawJson(
        JSON.stringify(
          buildSettings(appId, parsed, next, resolvedMeta),
          null,
          2,
        ),
      );
      setJsonError(null);
    } catch {
      setRawJson(
        JSON.stringify(buildSettings(appId, {}, next, resolvedMeta), null, 2),
      );
      setJsonError(null);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setJsonError("请填写线路名称");
      return;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawJson);
      if (
        !parsedJson ||
        typeof parsedJson !== "object" ||
        Array.isArray(parsedJson)
      ) {
        setJsonError("配置 JSON 必须是对象");
        return;
      }
      setJsonError(null);
    } catch (error) {
      setJsonError(`配置 JSON 格式无效：${String(error)}`);
      return;
    }

    // For CodeBuddy, each provider entry's key IS the model id in `~/.codebuddy/models.json`.
    const effectiveKey =
      providerKey.trim() ||
      (appId === "codebuddy" ? model.trim() : "") ||
      undefined;

    onSubmittingChange?.(true);
    try {
      await onSubmit({
        name: name.trim(),
        providerKey: effectiveKey,
        notes: notes.trim() || undefined,
        settingsConfig: JSON.stringify(parsedJson),
      });
    } finally {
      onSubmittingChange?.(false);
    }
  };

  const currentFields: ExtractedFields = {
    baseUrl,
    apiKey,
    model,
    protocol,
    maxContextSize,
  };

  return (
    <form
      id="provider-form"
      onSubmit={(e) => void handleSubmit(e)}
      className="editor-form"
    >
      <section className="editor-basic">
        <h3>基础信息</h3>
        <div className="editor-basic-grid">
          <div className="space-y-1.5">
            <label
              htmlFor="generic-provider-name"
              className="block text-sm font-medium text-foreground"
            >
              线路名称
            </label>
            <input
              id="generic-provider-name"
              type="text"
              required
              value={name}
              placeholder={`例如：${toolName} 主线路`}
              onChange={(e) => {
                const nextName = e.target.value;
                setName(nextName);
                if (appId === "codebuddy") {
                  syncJsonFromFields(currentFields, { name: nextName });
                }
                onDirtyChange?.();
              }}
            />
          </div>

          {!initialData && (
            <div className="space-y-1.5">
              <label
                htmlFor="generic-provider-key"
                className="block text-sm font-medium text-foreground"
              >
                {appId === "codebuddy"
                  ? "线路 / 模型标识（留空默认取下方模型 ID）"
                  : "线路标识（可选，默认自动生成）"}
              </label>
              <input
                id="generic-provider-key"
                type="text"
                value={providerKey}
                placeholder="小写字母、数字或连字符，例如 custom-api"
                onChange={(e) => {
                  const nextKey = e.target.value;
                  setProviderKey(nextKey);
                  if (appId === "kimi") {
                    syncJsonFromFields(currentFields, { key: nextKey });
                  }
                  onDirtyChange?.();
                }}
                className="font-mono"
              />
            </div>
          )}

          {protocolOptions && (
            <div className="space-y-1.5">
              <label
                htmlFor="generic-provider-protocol"
                className="block text-sm font-medium text-foreground"
              >
                API 协议
              </label>
              <select
                id="generic-provider-protocol"
                value={protocol}
                onChange={(e) => {
                  const nextProtocol = e.target.value;
                  setProtocol(nextProtocol);
                  syncJsonFromFields({
                    ...currentFields,
                    protocol: nextProtocol,
                  });
                  onDirtyChange?.();
                }}
                className="w-full min-h-[42px] px-3 py-2 text-sm border border-border rounded-[10px] bg-white text-foreground"
              >
                {protocolOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="space-y-1.5">
            <label
              htmlFor="generic-provider-url"
              className="block text-sm font-medium text-foreground"
            >
              请求地址（Base URL）
            </label>
            <input
              id="generic-provider-url"
              type="text"
              value={baseUrl}
              placeholder="https://api.example.com/v1"
              onChange={(e) => {
                const nextUrl = e.target.value;
                setBaseUrl(nextUrl);
                syncJsonFromFields({ ...currentFields, baseUrl: nextUrl });
                onDirtyChange?.();
              }}
              className="font-mono"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="generic-provider-key-secret"
              className="block text-sm font-medium text-foreground"
            >
              API Key
            </label>
            <div className="relative flex items-center">
              <input
                id="generic-provider-key-secret"
                type={showKey ? "text" : "password"}
                value={apiKey}
                placeholder="sk-..."
                onChange={(e) => {
                  const nextKey = e.target.value;
                  setApiKey(nextKey);
                  syncJsonFromFields({ ...currentFields, apiKey: nextKey });
                  onDirtyChange?.();
                }}
                className="pr-10 font-mono"
              />
              <button
                type="button"
                aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                onClick={() => setShowKey((prev) => !prev)}
                className="absolute right-2 p-1 text-muted-foreground hover:text-foreground"
              >
                {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="generic-provider-model"
              className="block text-sm font-medium text-foreground"
            >
              模型 ID
            </label>
            <input
              id="generic-provider-model"
              type="text"
              value={model}
              placeholder="输入该工具使用的模型 ID"
              onChange={(e) => {
                const nextModel = e.target.value;
                setModel(nextModel);
                syncJsonFromFields({ ...currentFields, model: nextModel });
                onDirtyChange?.();
              }}
              className="font-mono"
            />
          </div>

          {appId === "kimi" && (
            <div className="space-y-1.5">
              <label
                htmlFor="generic-provider-context"
                className="block text-sm font-medium text-foreground"
              >
                最大上下文窗口（Tokens）
              </label>
              <input
                id="generic-provider-context"
                type="number"
                min={1024}
                step={1024}
                value={maxContextSize}
                onChange={(e) => {
                  const nextCtx = asPositiveInt(e.target.value, 131072);
                  setMaxContextSize(nextCtx);
                  syncJsonFromFields({
                    ...currentFields,
                    maxContextSize: nextCtx,
                  });
                  onDirtyChange?.();
                }}
                className="font-mono"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <label
              htmlFor="generic-provider-notes"
              className="block text-sm font-medium text-foreground"
            >
              备注（可选）
            </label>
            <input
              id="generic-provider-notes"
              type="text"
              value={notes}
              placeholder="记录用途或限额说明"
              onChange={(e) => {
                setNotes(e.target.value);
                onDirtyChange?.();
              }}
            />
          </div>
        </div>
      </section>

      <div className="pt-3 border-t border-border/60">
        <button
          type="button"
          className="text-xs font-medium text-muted-foreground hover:text-foreground"
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced((prev) => !prev)}
        >
          {showAdvanced ? "收起原始配置 JSON" : "高级：编辑原始配置 JSON"}
        </button>
        {showAdvanced && (
          <div className="mt-2 space-y-1.5">
            <textarea
              aria-label="原始配置 JSON"
              rows={10}
              value={rawJson}
              onChange={(e) => {
                const nextRaw = e.target.value;
                setRawJson(nextRaw);
                onDirtyChange?.();
                try {
                  const parsed = asObject(JSON.parse(nextRaw));
                  const extracted = extractFields(appId, parsed);
                  setBaseUrl(extracted.baseUrl);
                  setApiKey(extracted.apiKey);
                  setModel(extracted.model);
                  if (extracted.protocol) setProtocol(extracted.protocol);
                  setMaxContextSize(extracted.maxContextSize);
                  setJsonError(null);
                } catch {
                  // Wait until valid JSON or submit
                }
              }}
              className="font-mono text-xs"
            />
          </div>
        )}
      </div>

      {jsonError && (
        <p role="alert" className="text-xs text-destructive">
          {jsonError}
        </p>
      )}
      {saveSummaryNote && (
        <p className="text-xs text-muted-foreground">{saveSummaryNote}</p>
      )}
    </form>
  );
}
