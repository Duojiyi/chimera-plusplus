import { getChimeraHubTemplate } from "@/config/codexTemplates";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { TriangleAlert } from "lucide-react";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@/components/ui/form";
import JsonEditor from "@/components/JsonEditor";
import {
  EditorAdvanced,
  EditorField,
  EditorLabel,
  EditorSelect,
  SectionStatus,
} from "@/components/providers/ProviderEditorFields";
import { useDarkMode } from "@/hooks/useDarkMode";
import { providerSchema, type ProviderFormData } from "@/lib/schemas/provider";
import {
  buildLocalProxyRequestOverrides,
  formatRequestOverrideObject,
} from "@/lib/requestOverrides";
import type {
  ClaudeApiKeyField,
  CodexApiFormat,
  CodexApiFormatSelection,
  CodexChatReasoning,
  PromptCacheRoutingMode,
  ProviderCategory,
  ProviderMeta,
} from "@/types";
import { maskToml } from "@/utils/deeplinkRisk";
import type { ProviderFormProps, ProviderFormValues } from "./ProviderForm";
import { BasicFormFields, MoreInfoFields } from "./BasicFormFields";
import { CodexFormFields } from "./CodexFormFields";
import { ProviderPresetSelector } from "./ProviderPresetSelector";
import {
  grokBuildOfficialPreset,
  grokBuildProviderPresets,
  type GrokBuildProviderPreset,
} from "@/config/grokBuildProviderPresets";
import {
  codexApiFormatFromWireApi,
  codexApiFormatForModel,
  extractCodexBaseUrl,
  extractCodexModelName,
  extractCodexWireApi,
} from "@/utils/providerConfigUtils";
import {
  GROK_BUILD_API_BACKENDS,
  GROK_BUILD_MISSING_KEY_ERROR,
  buildGrokBuildConfig,
  grokBuildConfigEditDropsComments,
  parseGrokBuildConfig,
  updateGrokBuildConfig,
  validateGrokBuildConfig,
} from "@/utils/grokBuildConfig";
import { resolveProviderIcon } from "@/utils/providerIcon";
import { GROKBUILD_OFFICIAL_PROVIDER_ID } from "@/utils/providerCapabilities";

type GrokBuildProviderFormProps = Omit<ProviderFormProps, "appId">;

// 预设列表见 grokBuildProviderPresets.ts：独立维护（与 Codex 预设无联动），
// 不含官方 / OAuth / 国产官方直连 / 纯开源托管站，默认模型为 Grok 系。
const grokPresetEntries: Array<{
  id: string;
  preset: GrokBuildProviderPreset;
}> = [
  { id: GROKBUILD_OFFICIAL_PROVIDER_ID, preset: grokBuildOfficialPreset },
  ...grokBuildProviderPresets.map((preset, index) => ({
    id: `grokbuild-${index}`,
    preset,
  })),
];

export const grokApiBackendFromApiFormat = (format: CodexApiFormat): string => {
  if (format === "openai_chat") return "chat_completions";
  if (format === "anthropic") return "messages";
  return "responses";
};

/** A real config.toml problem; a missing credential is a required field. */
const configFormatError = (config: string): string | null => {
  const error = validateGrokBuildConfig(config);
  return error === GROK_BUILD_MISSING_KEY_ERROR ? null : error;
};

const API_BACKEND_LABELS: Record<string, string> = {
  responses: "Responses",
  chat_completions: "Chat Completions",
  messages: "Anthropic Messages",
};

const grokApiFormatFromApiBackend = (backend: string): CodexApiFormat => {
  if (backend === "chat_completions") return "openai_chat";
  if (backend === "messages") return "anthropic";
  return "openai_responses";
};

export function GrokBuildProviderForm({
  providerId,
  submitLabel,
  onSubmit,
  onCancel,
  onSubmittingChange,
  onDirtyChange,
  onNameChange,
  onBaseUrlChange,
  initialData,
  showButtons = true,
}: GrokBuildProviderFormProps) {
  const { t } = useTranslation();
  const isDarkMode = useDarkMode();
  const initialConfigText =
    typeof initialData?.settingsConfig?.config === "string"
      ? initialData.settingsConfig.config
      : undefined;
  const initialConfig = useMemo(() => {
    const parsed = parseGrokBuildConfig(initialConfigText, initialData?.name);
    return initialData
      ? parsed
      : {
          ...parsed,
          upstreamModel: getChimeraHubTemplate().model,
          baseUrl: getChimeraHubTemplate().baseUrl,
          name: getChimeraHubTemplate().name,
        };
  }, [initialConfigText, initialData?.name]);

  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(
    initialData ? null : "grokbuild-0",
  );
  const [category, setCategory] = useState<ProviderCategory | undefined>(
    initialData?.category ?? (initialData ? "custom" : "third_party"),
  );
  const [isPartner, setIsPartner] = useState(
    initialData?.meta?.isPartner ?? false,
  );
  const [partnerPromotionKey, setPartnerPromotionKey] = useState<string>();
  const [profile, setProfile] = useState(initialConfig.model);
  const [upstreamModel, setUpstreamModel] = useState(
    initialConfig.upstreamModel ?? initialConfig.model,
  );
  const [baseUrl, setBaseUrl] = useState(initialConfig.baseUrl);
  const [apiKey, setApiKey] = useState(initialConfig.apiKey);
  const [apiBackend, setApiBackend] = useState(initialConfig.apiBackend);
  const [contextWindow, setContextWindow] = useState(
    String(initialConfig.contextWindow),
  );
  const [rawConfig, setRawConfig] = useState(
    initialConfigText ?? buildGrokBuildConfig(initialConfig),
  );
  const [apiFormat, setApiFormat] = useState<CodexApiFormatSelection>(() => {
    const savedFormat = initialData?.meta?.apiFormat as
      CodexApiFormat | undefined;
    if (savedFormat) return savedFormat;
    return initialData
      ? grokApiFormatFromApiBackend(initialConfig.apiBackend)
      : "openai_responses";
  });
  const [anthropicAuthField, setAnthropicAuthField] =
    useState<ClaudeApiKeyField>(
      initialData?.meta?.apiKeyField ?? "ANTHROPIC_AUTH_TOKEN",
    );
  const [impersonateClaudeCode, setImpersonateClaudeCode] = useState(
    initialData?.meta?.impersonateClaudeCode === true,
  );
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    initialData?.meta?.maxOutputTokens
      ? String(initialData.meta.maxOutputTokens)
      : "",
  );
  const [codexChatReasoning, setCodexChatReasoning] =
    useState<CodexChatReasoning>(initialData?.meta?.codexChatReasoning ?? {});
  const [promptCacheRouting, setPromptCacheRouting] =
    useState<PromptCacheRoutingMode>(
      initialData?.meta?.promptCacheRouting ?? "auto",
    );
  const [isFullUrl, setIsFullUrl] = useState(
    initialData?.meta?.isFullUrl ?? false,
  );
  const [customUserAgent, setCustomUserAgent] = useState(
    initialData?.meta?.customUserAgent ?? "",
  );
  const [headersOverride, setHeadersOverride] = useState(
    formatRequestOverrideObject(
      initialData?.meta?.localProxyRequestOverrides?.headers,
    ),
  );
  const [bodyOverride, setBodyOverride] = useState(
    formatRequestOverrideObject(
      initialData?.meta?.localProxyRequestOverrides?.body,
    ),
  );
  const [endpointAutoSelect, setEndpointAutoSelect] = useState(
    initialData?.meta?.endpointAutoSelect ?? true,
  );
  const [isEndpointModalOpen, setIsEndpointModalOpen] = useState(false);
  const [presetEndpoints, setPresetEndpoints] = useState<string[]>([]);
  const [draftCustomEndpoints, setDraftCustomEndpoints] = useState<string[]>(
    [],
  );

  const form = useForm<ProviderFormData>({
    resolver: zodResolver(providerSchema),
    defaultValues: {
      name: initialData?.name ?? initialConfig.name,
      websiteUrl: initialData?.websiteUrl ?? "",
      notes: initialData?.notes ?? "",
      settingsConfig: JSON.stringify({ config: rawConfig }),
      icon:
        resolveProviderIcon(
          "grokbuild",
          initialData?.icon,
          initialData?.iconColor,
        ) ?? "",
      iconColor: initialData?.iconColor ?? "",
    },
    mode: "onSubmit",
  });
  const { isSubmitting } = form.formState;
  const websiteUrl = form.watch("websiteUrl") ?? "";
  const watchedName = form.watch("name");
  useEffect(() => {
    onNameChange?.(watchedName ?? "");
  }, [watchedName, onNameChange]);
  useEffect(() => {
    onBaseUrlChange?.(category === "official" ? null : baseUrl);
  }, [baseUrl, category, onBaseUrlChange]);
  // The raw editor opens on a broken file and stays open while it is fixed.
  const [rawConfigOpen, setRawConfigOpen] = useState(() =>
    Boolean(initialConfigText && configFormatError(initialConfigText)),
  );
  // The raw file carries api_key in clear text; like the API Key field it
  // stays masked until the user asks to edit the file itself.
  const [rawConfigEditing, setRawConfigEditing] = useState(false);

  useEffect(() => {
    onSubmittingChange?.(isSubmitting);
  }, [isSubmitting, onSubmittingChange]);

  const draftState = JSON.stringify([
    profile,
    upstreamModel,
    baseUrl,
    apiKey,
    apiBackend,
    contextWindow,
    rawConfig,
    apiFormat,
    anthropicAuthField,
    impersonateClaudeCode,
    maxOutputTokens,
    codexChatReasoning,
    promptCacheRouting,
    isFullUrl,
    customUserAgent,
    headersOverride,
    bodyOverride,
    endpointAutoSelect,
    draftCustomEndpoints,
    selectedPresetId,
  ]);
  const previousDraftState = useRef(draftState);
  useEffect(() => {
    if (previousDraftState.current !== draftState) {
      previousDraftState.current = draftState;
      onDirtyChange?.();
    }
  }, [draftState, onDirtyChange]);

  // Grok Build 预设已不含 cn_official（国产官方直连无法在 Grok CLI 使用）
  const presetCategoryLabels = useMemo(
    () => ({
      official: t("providerForm.categoryOfficial", { defaultValue: "官方" }),
      aggregator: t("providerForm.categoryAggregation", {
        defaultValue: "聚合服务",
      }),
      third_party: t("providerForm.categoryThirdParty", {
        defaultValue: "第三方",
      }),
    }),
    [t],
  );

  const speedTestEndpoints = useMemo(() => {
    const urls = new Set<string>();
    const add = (url?: string) => {
      const normalized = url?.trim().replace(/\/+$/, "");
      if (normalized) urls.add(normalized);
    };
    add(baseUrl);
    presetEndpoints.forEach(add);
    draftCustomEndpoints.forEach(add);
    return Array.from(urls).map((url) => ({ url }));
  }, [baseUrl, draftCustomEndpoints, presetEndpoints]);

  // Only a broken file blocks syncing; a key not entered yet must still let
  // the API Key field write into the generated config.
  const invalidRawDraft = useRef(
    Boolean(initialConfigText && configFormatError(initialConfigText)),
  );

  const syncStructuredConfig = (
    overrides: Partial<ReturnType<typeof parseGrokBuildConfig>>,
  ) => {
    if (invalidRawDraft.current) return;
    const next = {
      model: profile,
      upstreamModel,
      baseUrl,
      name: form.getValues("name") || initialConfig.name,
      apiKey,
      apiBackend,
      contextWindow: Number.parseInt(contextWindow, 10),
      ...overrides,
    };
    try {
      setRawConfig(updateGrokBuildConfig(rawConfig, next));
    } catch {
      // Preserve the draft and inline error until its syntax is repaired.
    }
  };

  const handlePresetChange = (presetId: string) => {
    setSelectedPresetId(presetId);
    if (presetId === "custom") {
      setCategory("custom");
      setIsPartner(false);
      setPartnerPromotionKey(undefined);
      setPresetEndpoints([]);
      return;
    }

    if (presetId === GROKBUILD_OFFICIAL_PROVIDER_ID) {
      invalidRawDraft.current = false;
      // 官方登录：无 API Key / 地址 / 模型表可填，提交走 ensure seed 流程
      form.setValue("name", grokBuildOfficialPreset.name);
      form.setValue("websiteUrl", grokBuildOfficialPreset.websiteUrl);
      form.setValue("icon", grokBuildOfficialPreset.icon ?? "");
      form.setValue("iconColor", grokBuildOfficialPreset.iconColor ?? "");
      setCategory("official");
      setIsPartner(false);
      setPartnerPromotionKey(undefined);
      setPresetEndpoints([]);
      setRawConfig("");
      return;
    }

    const entry = grokPresetEntries.find(
      (candidate) => candidate.id === presetId,
    );
    if (!entry) return;
    invalidRawDraft.current = false;
    const preset = entry.preset;
    const presetName = preset.nameKey ? String(t(preset.nameKey)) : preset.name;
    const presetBaseUrl = extractCodexBaseUrl(preset.config) ?? "";
    const presetModel = extractCodexModelName(preset.config) ?? profile;
    const presetApiFormat =
      preset.apiFormat ??
      codexApiFormatFromWireApi(extractCodexWireApi(preset.config)) ??
      "openai_responses";
    const presetApiKey =
      "auth" in preset && typeof preset.auth?.OPENAI_API_KEY === "string"
        ? preset.auth.OPENAI_API_KEY
        : "";
    const presetApiBackend = grokApiBackendFromApiFormat(presetApiFormat);

    form.setValue("name", presetName);
    form.setValue("websiteUrl", preset.websiteUrl ?? "");
    form.setValue("icon", preset.icon ?? "");
    form.setValue("iconColor", preset.iconColor ?? "");
    setCategory(preset.category ?? "custom");
    setIsPartner(preset.isPartner ?? false);
    setPartnerPromotionKey(preset.partnerPromotionKey);
    setBaseUrl(presetBaseUrl);
    setApiKey(presetApiKey);
    setUpstreamModel(presetModel);
    setApiFormat(presetApiFormat);
    setApiBackend(presetApiBackend);
    setPresetEndpoints(preset.endpointCandidates ?? []);
    setRawConfig(
      buildGrokBuildConfig({
        model: profile,
        upstreamModel: presetModel,
        baseUrl: presetBaseUrl,
        name: presetName,
        apiKey: presetApiKey,
        apiBackend: presetApiBackend,
        contextWindow: Number.parseInt(contextWindow, 10),
      }),
    );
  };

  const handleRawConfigChange = (value: string) => {
    setRawConfig(value);
    invalidRawDraft.current = Boolean(configFormatError(value));
    if (invalidRawDraft.current) return;
    const parsed = parseGrokBuildConfig(value, form.getValues("name"));
    setProfile(parsed.model);
    setUpstreamModel(parsed.upstreamModel ?? parsed.model);
    setBaseUrl(parsed.baseUrl);
    setApiKey(parsed.apiKey);
    setApiBackend(parsed.apiBackend);
    setContextWindow(String(parsed.contextWindow));
    if (parsed.name) form.setValue("name", parsed.name);
  };

  const handleSubmit = async (values: ProviderFormData) => {
    const name = values.name.trim();

    // 官方条目：config 快照原样透传（新增时为空），不做自定义模型字段校验，
    // 也不重建 config —— 新增走 ensure seed，编辑只允许改名称/图标等元信息。
    if (category === "official") {
      await onSubmit({
        ...values,
        name,
        websiteUrl: values.websiteUrl?.trim() ?? "",
        notes: values.notes?.trim() ?? "",
        settingsConfig: JSON.stringify({ config: rawConfig }),
        presetId: selectedPresetId ?? undefined,
        presetCategory: "official",
        isPartner: false,
        meta: initialData?.meta,
      });
      return;
    }

    // A missing key is reported by the required-fields check below.
    const draftError = configFormatError(rawConfig);
    if (draftError) {
      toast.error(
        t("grokBuild.invalidToml", {
          error: draftError,
          defaultValue: `Invalid config.toml: ${draftError}`,
        }),
      );
      return;
    }

    const parsedContextWindow = Number.parseInt(contextWindow, 10);
    const envKey = parseGrokBuildConfig(rawConfig).envKey?.trim();
    if (
      !name ||
      !baseUrl.trim() ||
      (!apiKey.trim() && !envKey) ||
      !profile.trim()
    ) {
      toast.error(
        t("providerForm.requiredFields", {
          defaultValue: "请填写供应商名称、API 地址、API Key 和模型",
        }),
      );
      return;
    }
    if (!Number.isInteger(parsedContextWindow) || parsedContextWindow <= 0) {
      toast.error(
        t("grokBuild.contextWindowInvalid", {
          defaultValue: "上下文窗口必须是正整数",
        }),
      );
      return;
    }

    let resolvedApiFormat: CodexApiFormat =
      apiFormat === "auto" ? "openai_responses" : apiFormat;
    let resolvedAnthropicAuthField = anthropicAuthField;
    let resolvedApiBackend = apiBackend;
    let detectedModelFormats: Record<
      string,
      { apiFormat: CodexApiFormat; anthropicAuthField?: ClaudeApiKeyField }
    > = {};
    if (apiFormat === "auto") {
      const modelNames = Array.from(
        new Set([upstreamModel.trim(), profile.trim()].filter(Boolean)),
      );
      detectedModelFormats = Object.fromEntries(
        modelNames.map((model) => [
          model,
          { apiFormat: codexApiFormatForModel(model) },
        ]),
      );
      resolvedApiFormat = codexApiFormatForModel(upstreamModel || profile);
      resolvedApiBackend = grokApiBackendFromApiFormat(resolvedApiFormat);
      setApiFormat(resolvedApiFormat);
      setApiBackend(resolvedApiBackend);
    }

    const finalConfig = updateGrokBuildConfig(rawConfig, {
      model: profile,
      upstreamModel,
      baseUrl,
      name,
      apiKey,
      apiBackend: resolvedApiBackend,
      contextWindow: parsedContextWindow,
    });
    const configError = validateGrokBuildConfig(finalConfig);
    if (configError) {
      toast.error(
        t("grokBuild.invalidToml", {
          error: configError,
          defaultValue: `config.toml 格式错误: ${configError}`,
        }),
      );
      return;
    }

    const requestOverrides = buildLocalProxyRequestOverrides(
      headersOverride,
      bodyOverride,
    );
    if (requestOverrides.error) {
      toast.error(requestOverrides.error);
      return;
    }

    const customEndpoints = Object.fromEntries(
      draftCustomEndpoints.map((url) => [
        url,
        { url, addedAt: Date.now(), lastUsed: undefined },
      ]),
    );
    const parsedMaxOutputTokens = Number.parseInt(maxOutputTokens, 10);
    const initialMeta = { ...(initialData?.meta ?? {}) };
    delete initialMeta.custom_endpoints;
    const meta: ProviderMeta = {
      ...initialMeta,
      apiFormat: resolvedApiFormat,
      apiKeyField: resolvedAnthropicAuthField,
      isFullUrl,
      endpointAutoSelect,
      isPartner,
      partnerPromotionKey,
      impersonateClaudeCode,
      promptCacheRouting,
      codexChatReasoning,
      codexModelApiFormats:
        apiFormat === "auto"
          ? Object.fromEntries(
              Object.entries(detectedModelFormats).map(([model, detected]) => [
                model,
                detected.apiFormat,
              ]),
            )
          : undefined,
      customUserAgent: customUserAgent.trim() || undefined,
      localProxyRequestOverrides: requestOverrides.overrides,
      maxOutputTokens:
        Number.isInteger(parsedMaxOutputTokens) && parsedMaxOutputTokens > 0
          ? parsedMaxOutputTokens
          : undefined,
    };
    if (!providerId && Object.keys(customEndpoints).length > 0) {
      meta.custom_endpoints = customEndpoints;
    }
    const payload: ProviderFormValues = {
      ...values,
      name,
      websiteUrl: values.websiteUrl?.trim() ?? "",
      notes: values.notes?.trim() ?? "",
      settingsConfig: JSON.stringify({ config: finalConfig }),
      presetId: selectedPresetId ?? undefined,
      presetCategory: category ?? "custom",
      isPartner,
      meta,
    };

    await onSubmit(payload);
  };

  const rawConfigError = configFormatError(rawConfig);
  useEffect(() => {
    if (rawConfigError) setRawConfigOpen(true);
  }, [rawConfigError]);
  // A broken file can only be fixed in the editor, so it opens editable.
  const rawConfigPlain = rawConfigEditing || Boolean(rawConfigError);
  const keyMissing =
    !rawConfigError &&
    validateGrokBuildConfig(rawConfig) === GROK_BUILD_MISSING_KEY_ERROR;
  // A hand-written layout the fields cannot edit in place: the next field
  // edit rewrites the file in the standard layout and its comments go.
  const commentsAtRisk = useMemo(
    () =>
      !rawConfigError &&
      category !== "official" &&
      grokBuildConfigEditDropsComments(rawConfig),
    [rawConfig, rawConfigError, category],
  );
  const backendOptions = (
    GROK_BUILD_API_BACKENDS as readonly string[]
  ).includes(apiBackend)
    ? GROK_BUILD_API_BACKENDS
    : [apiBackend, ...GROK_BUILD_API_BACKENDS];
  const envKey = parseGrokBuildConfig(rawConfig).envKey?.trim();
  const basicMissing = [
    watchedName,
    baseUrl,
    ...(envKey ? [] : [apiKey]),
  ].filter((value) => !value?.trim()).length;
  const protocolMissing = profile.trim() ? 0 : 1;

  return (
    <Form {...form}>
      <form
        id="provider-form"
        onSubmit={form.handleSubmit(handleSubmit)}
        className="editor-form"
      >
        {!initialData && (
          <ProviderPresetSelector
            selectedPresetId={selectedPresetId}
            presetEntries={grokPresetEntries}
            presetCategoryLabels={presetCategoryLabels}
            onPresetChange={handlePresetChange}
            category={category}
          />
        )}

        {commentsAtRisk && (
          <p className="editor-model-notice is-warning" role="status">
            <TriangleAlert size={15} aria-hidden="true" />
            <span>
              这份 config.toml
              的写法无法逐项修改：改动下面的地址、密钥或模型会按标准格式重写整个文件，其中的注释会被删除。要保留注释，请在“客户端档位与原始配置”里直接编辑。
            </span>
          </p>
        )}

        {category === "official" ? (
          <section className="editor-basic" aria-labelledby="grokbuild-basic">
            <div className="editor-section-head">
              <h3 id="grokbuild-basic">基础</h3>
              <SectionStatus missing={watchedName?.trim() ? 0 : 1} />
            </div>
            <div className="editor-basic-grid">
              <BasicFormFields form={form} />
              <p className="editor-model-notice">
                官方入口使用 Grok Build 自身的登录，无需填写地址、密钥或模型。
              </p>
              <MoreInfoFields form={form} />
            </div>
          </section>
        ) : (
          <>
            <CodexFormFields
              appId="grokbuild"
              providerId={providerId}
              basicLead={<BasicFormFields form={form} />}
              basicTail={<MoreInfoFields form={form} />}
              basicStatus={<SectionStatus missing={basicMissing} />}
              protocolStatus={<SectionStatus missing={protocolMissing} />}
              codexApiKey={apiKey}
              apiKeyRequired={!envKey}
              apiKeyHelp="密钥写入 Grok Build 的 config.toml（api_key）；也可以在原始配置里改用 env_key 读取环境变量。"
              onApiKeyChange={(value) => {
                setApiKey(value);
                syncStructuredConfig({ apiKey: value });
              }}
              category={category}
              shouldShowApiKeyLink={Boolean(websiteUrl)}
              websiteUrl={websiteUrl}
              isPartner={isPartner}
              partnerPromotionKey={partnerPromotionKey}
              shouldShowSpeedTest
              codexBaseUrl={baseUrl}
              addressHelp="Grok Build 按所选协议在这个地址后拼接请求路径，例如 Responses 拼接 /responses；开启完整 URL 时按原样请求。"
              onBaseUrlChange={(value) => {
                setBaseUrl(value);
                syncStructuredConfig({ baseUrl: value });
              }}
              isFullUrl={isFullUrl}
              onFullUrlChange={setIsFullUrl}
              isEndpointModalOpen={isEndpointModalOpen}
              onEndpointModalToggle={setIsEndpointModalOpen}
              onCustomEndpointsChange={setDraftCustomEndpoints}
              autoSelect={endpointAutoSelect}
              onAutoSelectChange={setEndpointAutoSelect}
              codexModel={upstreamModel}
              onModelChange={(value) => {
                setUpstreamModel(value);
                syncStructuredConfig({ upstreamModel: value });
              }}
              apiFormat={apiFormat}
              allowAutoApiFormat
              onApiFormatChange={(value) => {
                setApiFormat(value);
                if (value === "auto") return;
                const backend = grokApiBackendFromApiFormat(value);
                setApiBackend(backend);
                syncStructuredConfig({ apiBackend: backend });
              }}
              anthropicAuthField={anthropicAuthField}
              onAnthropicAuthFieldChange={setAnthropicAuthField}
              impersonateClaudeCode={impersonateClaudeCode}
              onImpersonateClaudeCodeChange={setImpersonateClaudeCode}
              maxOutputTokens={maxOutputTokens}
              onMaxOutputTokensChange={setMaxOutputTokens}
              codexChatReasoning={codexChatReasoning}
              onCodexChatReasoningChange={setCodexChatReasoning}
              promptCacheRouting={promptCacheRouting}
              onPromptCacheRoutingChange={setPromptCacheRouting}
              speedTestEndpoints={speedTestEndpoints}
              customUserAgent={customUserAgent}
              onCustomUserAgentChange={setCustomUserAgent}
              localProxyHeadersOverride={headersOverride}
              onLocalProxyHeadersOverrideChange={setHeadersOverride}
              localProxyBodyOverride={bodyOverride}
              onLocalProxyBodyOverrideChange={setBodyOverride}
            />

            <EditorAdvanced
              className="editor-raw-config"
              title="客户端档位与原始配置"
              summary="config.toml"
              open={rawConfigOpen}
              onToggle={setRawConfigOpen}
            >
              <div className="editor-grok-profile">
                <EditorField
                  label={t("grokBuild.profile", {
                    defaultValue: "客户端模型档位",
                  })}
                  htmlFor="grokbuild-profile"
                >
                  <input
                    id="grokbuild-profile"
                    value={profile}
                    onChange={(event) => {
                      const value = event.target.value;
                      setProfile(value);
                      syncStructuredConfig({ model: value });
                    }}
                    placeholder="grok-4.5"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </EditorField>

                <EditorField
                  label={t("grokBuild.apiBackend", {
                    defaultValue: "API Backend",
                  })}
                  htmlFor="grokbuild-api-backend"
                >
                  <EditorSelect
                    id="grokbuild-api-backend"
                    value={apiBackend}
                    onChange={(value) => {
                      setApiBackend(value);
                      syncStructuredConfig({ apiBackend: value });
                      // Keep the protocol selector in step with the backend.
                      setApiFormat(grokApiFormatFromApiBackend(value));
                    }}
                    options={backendOptions.map((value) => [
                      value,
                      API_BACKEND_LABELS[value]
                        ? `${API_BACKEND_LABELS[value]} (${value})`
                        : value,
                    ])}
                  />
                </EditorField>

                <EditorField
                  label={t("grokBuild.contextWindow", {
                    defaultValue: "上下文窗口",
                  })}
                  htmlFor="grokbuild-context-window"
                >
                  <input
                    id="grokbuild-context-window"
                    type="number"
                    min={1}
                    step={1}
                    value={contextWindow}
                    onChange={(event) => {
                      const value = event.target.value;
                      setContextWindow(value);
                      syncStructuredConfig({
                        contextWindow: Number.parseInt(value, 10),
                      });
                    }}
                  />
                </EditorField>
              </div>

              <div className="editor-field">
                <EditorLabel
                  id="grokbuild-config-toml-label"
                  label={t("grokBuild.rawConfig", {
                    defaultValue: "config.toml",
                  })}
                />
                <div
                  className="editor-code-editor"
                  role="group"
                  aria-labelledby="grokbuild-config-toml-label"
                >
                  <JsonEditor
                    value={rawConfigPlain ? rawConfig : maskToml(rawConfig)}
                    // The masked view must never be written back as the file.
                    onChange={
                      rawConfigPlain ? handleRawConfigChange : () => undefined
                    }
                    readOnly={!rawConfigPlain}
                    placeholder=""
                    darkMode={isDarkMode}
                    rows={12}
                    showValidation={false}
                    language="javascript"
                  />
                </div>
                {!rawConfigPlain && (
                  <small>
                    API Key 只显示末 4 位。
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => setRawConfigEditing(true)}
                    >
                      编辑原始配置
                    </button>
                  </small>
                )}
                {keyMissing && (
                  <small role="status">
                    填写 API Key 后会写入 api_key；也可在这里改用 env_key
                    读取环境变量。
                  </small>
                )}
                {rawConfigError && (
                  <small className="is-error" role="alert">
                    {t("grokBuild.invalidToml", {
                      error: rawConfigError,
                      defaultValue: `Invalid config.toml: ${rawConfigError}`,
                    })}
                  </small>
                )}
              </div>
            </EditorAdvanced>
          </>
        )}

        <FormField
          control={form.control}
          name="settingsConfig"
          render={() => (
            <FormItem className="hidden">
              <FormControl>
                <input type="hidden" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {showButtons && (
          <div className="editor-save-actions">
            <button type="button" className="secondary" onClick={onCancel}>
              {t("common.cancel", { defaultValue: "取消" })}
            </button>
            <button type="submit" className="primary" disabled={isSubmitting}>
              {submitLabel}
            </button>
          </div>
        )}
      </form>
    </Form>
  );
}
