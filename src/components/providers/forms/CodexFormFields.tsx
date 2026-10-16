import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FormLabel } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { toast } from "sonner";
import {
  Check,
  ChevronsUpDown,
  Download,
  Loader2,
  Plus,
  Route,
  Trash2,
} from "lucide-react";
import EndpointSpeedTest from "./EndpointSpeedTest";
import { ApiKeySection, EndpointField, ModelDropdown } from "./shared";
import {
  ANTHROPIC_AUTH_HELP,
  ANTHROPIC_AUTH_OPTIONS,
  EditorAdvanced,
  EditorChoice,
  EditorField,
  EditorLabel,
  EditorToggle,
  PROMPT_CACHE_OPTIONS,
  ROUTED_PROTOCOL_NOTE,
  type EditorChoiceOption,
} from "@/components/providers/ProviderEditorFields";
import { codexApiFormatForModel } from "@/utils/providerConfigUtils";
import { XaiOAuthSection } from "./XaiOAuthSection";
import {
  fetchModelsForConfig,
  fetchXaiOauthModels,
  showFetchModelsError,
  type FetchedModel,
} from "@/lib/api/model-fetch";
import { CustomUserAgentField } from "./CustomUserAgentField";
import { LocalProxyRequestOverridesField } from "./LocalProxyRequestOverridesField";
import { cn } from "@/lib/utils";
import {
  catalogInputModalities,
  catalogRowSupportsImage,
} from "@/chimeraUtils";
import type {
  ClaudeApiKeyField,
  CodexApiFormat,
  CodexApiFormatSelection,
  CodexCatalogModel,
  CodexChatReasoning,
  CodexModelRoute,
  PromptCacheRoutingMode,
  ProviderCategory,
} from "@/types";
import type { AppId } from "@/lib/api";

interface EndpointCandidate {
  url: string;
}

interface CodexFormFieldsProps {
  appId?: AppId;
  providerId?: string;
  /** Rendered first in the 基础 section, such as the line name field. */
  basicLead?: ReactNode;
  /** Rendered last in the 基础 section, such as 更多信息. */
  basicTail?: ReactNode;
  /** Status pills beside the 基础 and 协议与模型 headings. */
  basicStatus?: ReactNode;
  protocolStatus?: ReactNode;
  // xAI OAuth 托管预设（Grok 订阅）：隐藏 API Key / 端点输入，挂账号选择区块
  isXaiOauthPreset?: boolean;
  isXaiOauthAuthenticated?: boolean;
  selectedXaiAccountId?: string | null;
  onXaiAccountSelect?: (accountId: string | null) => void;
  // API Key
  codexApiKey: string;
  onApiKeyChange: (key: string) => void;
  /** The key is required (another credential source can make it optional). */
  apiKeyRequired?: boolean;
  apiKeyHelp?: ReactNode;
  category?: ProviderCategory;
  shouldShowApiKeyLink: boolean;
  websiteUrl: string;
  isPartner?: boolean;
  partnerPromotionKey?: string;

  // Base URL
  shouldShowSpeedTest: boolean;
  codexBaseUrl: string;
  addressHelp?: ReactNode;
  onBaseUrlChange: (url: string) => void;
  isFullUrl: boolean;
  onFullUrlChange: (value: boolean) => void;
  isEndpointModalOpen: boolean;
  onEndpointModalToggle: (open: boolean) => void;
  onCustomEndpointsChange?: (endpoints: string[]) => void;
  autoSelect: boolean;
  onAutoSelectChange: (checked: boolean) => void;

  // Default model (config.toml top-level `model`)
  codexModel?: string;
  onModelChange?: (model: string) => void;

  // API Format
  // Note: wire_api is always "responses" for Codex; apiFormat controls proxy-layer conversion
  apiFormat: CodexApiFormatSelection;
  onApiFormatChange: (format: CodexApiFormatSelection) => void;
  // Only the Codex provider can resolve `auto` through the backend capability probe.
  allowAutoApiFormat?: boolean;
  // Auth field for the Anthropic Messages upstream (only used when apiFormat === "anthropic")
  anthropicAuthField: ClaudeApiKeyField;
  onAnthropicAuthFieldChange: (value: ClaudeApiKeyField) => void;
  // Anthropic path: whether to emulate the Claude Code client
  impersonateClaudeCode: boolean;
  onImpersonateClaudeCodeChange: (value: boolean) => void;
  // Anthropic path: output ceiling override (empty string = use default). Digits only.
  maxOutputTokens: string;
  onMaxOutputTokensChange: (value: string) => void;
  codexChatReasoning?: CodexChatReasoning;
  onCodexChatReasoningChange?: (value: CodexChatReasoning) => void;
  promptCacheRouting: PromptCacheRoutingMode;
  onPromptCacheRoutingChange: (value: PromptCacheRoutingMode) => void;

  // Model Catalog
  catalogModels?: CodexCatalogModel[];
  onCatalogModelsChange?: (models: CodexCatalogModel[]) => void;

  // Per-model upstream routes (v2.5.0)：键为实际请求模型名
  modelRoutes?: Record<string, CodexModelRoute>;
  onModelRoutesChange?: (routes: Record<string, CodexModelRoute>) => void;

  // Speed Test Endpoints
  speedTestEndpoints: EndpointCandidate[];

  // Local proxy User-Agent override
  customUserAgent: string;
  onCustomUserAgentChange: (value: string) => void;
  localProxyHeadersOverride: string;
  onLocalProxyHeadersOverrideChange: (value: string) => void;
  localProxyBodyOverride: string;
  onLocalProxyBodyOverrideChange: (value: string) => void;
}

type CodexCatalogRow = CodexCatalogModel & { rowId: string };

// The protocol choices of the line editor (ChimeraApp CODEX_FORMAT_OPTIONS):
// one segmented control, each note read as the option's description.
const CODEX_FORMAT_CHOICES: ReadonlyArray<
  EditorChoiceOption<CodexApiFormatSelection>
> = [
  ["auto", "自动", "按默认模型的名称推断"],
  ["openai_responses", "Responses", "上游原生支持，可直连"],
  ["openai_chat", "Chat Completions", ROUTED_PROTOCOL_NOTE],
  ["anthropic", "Anthropic Messages", ROUTED_PROTOCOL_NOTE],
];

const CODEX_FORMAT_LABELS: Record<CodexApiFormat, string> = {
  openai_responses: "Responses",
  openai_chat: "Chat Completions",
  anthropic: "Anthropic Messages",
};

function createCatalogRow(seed?: Partial<CodexCatalogModel>): CodexCatalogRow {
  return {
    rowId: crypto.randomUUID(),
    model: seed?.model ?? "",
    displayName: seed?.displayName ?? "",
    contextWindow: seed?.contextWindow ?? "",
    // Carry native-profile overrides verbatim (not user-editable in the row UI,
    // but must survive load->save so the official catalog fidelity is kept).
    ...(seed?.supportsParallelToolCalls !== undefined
      ? { supportsParallelToolCalls: seed.supportsParallelToolCalls }
      : {}),
    ...(seed?.inputModalities ? { inputModalities: seed.inputModalities } : {}),
    ...(seed?.baseInstructions
      ? { baseInstructions: seed.baseInstructions }
      : {}),
    ...(seed?.reasoningLevels && seed.reasoningLevels.length > 0
      ? { reasoningLevels: seed.reasoningLevels }
      : {}),
    ...(seed?.defaultReasoningLevel
      ? { defaultReasoningLevel: seed.defaultReasoningLevel }
      : {}),
  };
}

// Compares rows (with rowId) to incoming models (without) by data fields only,
// so both sync effects can use the same equality definition. Hidden native-profile
// fields are included so switching between providers with identical visible fields
// but different base_instructions / tools / modalities still rebuilds the rows.
function catalogRowsMatchModels(
  rows: CodexCatalogModel[],
  models: CodexCatalogModel[],
): boolean {
  if (rows.length !== models.length) return false;
  return rows.every((row, i) => {
    const incoming = models[i];
    return (
      row.model === (incoming.model ?? "") &&
      (row.displayName ?? "") === (incoming.displayName ?? "") &&
      String(row.contextWindow ?? "") ===
        String(incoming.contextWindow ?? "") &&
      (row.supportsParallelToolCalls ?? null) ===
        (incoming.supportsParallelToolCalls ?? null) &&
      (row.baseInstructions ?? "") === (incoming.baseInstructions ?? "") &&
      JSON.stringify(row.inputModalities ?? []) ===
        JSON.stringify(incoming.inputModalities ?? []) &&
      JSON.stringify(row.reasoningLevels ?? []) ===
        JSON.stringify(incoming.reasoningLevels ?? []) &&
      (row.defaultReasoningLevel ?? "") ===
        (incoming.defaultReasoningLevel ?? "")
    );
  });
}

// Reasoning effort levels Codex understands, in ascending depth order. The
// backend drops unknown values, so the UI only offers canonical ones.
const CODEX_REASONING_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

// Sentinel for the default-level Select: Radix Select forbids empty item
// values, so "back to Auto" needs a non-empty value mapped to undefined.
const AUTO_DEFAULT_REASONING_LEVEL = "__auto__";

function ReasoningLevelsEditor({
  levels,
  defaultLevel,
  onLevelsChange,
  onDefaultLevelChange,
}: {
  levels?: string[];
  defaultLevel?: string;
  onLevelsChange: (levels: string[] | undefined) => void;
  onDefaultLevelChange: (level: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const selected = (levels ?? []).filter((level) =>
    (CODEX_REASONING_LEVELS as readonly string[]).includes(level),
  );

  const toggleLevel = (level: string) => {
    const picked = selected.includes(level)
      ? selected.filter((item) => item !== level)
      : [...selected, level];
    // Store in canonical ascending-depth order (not click order): the Codex
    // picker and the generated catalog both follow array order.
    const next = (CODEX_REASONING_LEVELS as readonly string[]).filter((item) =>
      picked.includes(item),
    );
    onLevelsChange(next.length > 0 ? next : undefined);
    if (defaultLevel && !next.includes(defaultLevel)) {
      onDefaultLevelChange(undefined);
    }
  };

  const triggerLabel =
    selected.length > 0
      ? selected.join(", ")
      : t("codexConfig.reasoningLevelsNotSet", {
          defaultValue: "Not set",
        });

  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          className="flex h-9 w-full items-center justify-between gap-1 rounded-md border border-border-default bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus-visible:outline-none focus:border-border-default focus-visible:border-border-default focus:ring-0 focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span
            className={cn(
              "truncate",
              selected.length === 0 && "text-muted-foreground",
            )}
          >
            {triggerLabel}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        avoidCollisions
        collisionPadding={8}
        className="z-[1000] w-[var(--radix-popover-trigger-width)] p-0 border-border-default"
      >
        <Command>
          <CommandInput
            placeholder={t("codexConfig.reasoningLevelsSearch", {
              defaultValue: "Search reasoning levels...",
            })}
          />
          <CommandList>
            <CommandEmpty>
              {t("codexConfig.reasoningLevelsEmpty", {
                defaultValue: "No levels",
              })}
            </CommandEmpty>
            <CommandGroup>
              {CODEX_REASONING_LEVELS.map((level) => (
                <CommandItem
                  key={level}
                  value={level}
                  onSelect={() => toggleLevel(level)}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      selected.includes(level) ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="flex-1">{level}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        {selected.length > 0 && (
          <div className="border-t border-border-default p-2">
            <span className="text-xs text-muted-foreground">
              {t("codexConfig.defaultReasoningLevelLabel", {
                defaultValue: "Default level",
              })}
            </span>
            <Select
              value={defaultLevel ?? AUTO_DEFAULT_REASONING_LEVEL}
              onValueChange={(value) =>
                onDefaultLevelChange(
                  value === AUTO_DEFAULT_REASONING_LEVEL ? undefined : value,
                )
              }
            >
              <SelectTrigger className="mt-1 h-8 w-full">
                <SelectValue
                  placeholder={t(
                    "codexConfig.defaultReasoningLevelPlaceholder",
                    { defaultValue: "Auto" },
                  )}
                />
              </SelectTrigger>
              {/* Must render above the enclosing z-[1000] popover: the
                  default SelectContent z-[100] would hide the menu behind
                  the panel when it flips upward. */}
              <SelectContent className="z-[1100]">
                <SelectItem value={AUTO_DEFAULT_REASONING_LEVEL}>
                  {t("codexConfig.defaultReasoningLevelPlaceholder", {
                    defaultValue: "Auto",
                  })}
                </SelectItem>
                {selected.map((level) => (
                  <SelectItem key={level} value={level}>
                    {level}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function CodexFormFields({
  appId = "codex",
  providerId,
  basicLead,
  basicTail,
  basicStatus,
  protocolStatus,
  isXaiOauthPreset,
  isXaiOauthAuthenticated,
  selectedXaiAccountId,
  onXaiAccountSelect,
  codexApiKey,
  onApiKeyChange,
  apiKeyRequired = false,
  apiKeyHelp,
  category,
  shouldShowApiKeyLink,
  websiteUrl,
  isPartner,
  partnerPromotionKey,
  shouldShowSpeedTest,
  codexBaseUrl,
  addressHelp,
  onBaseUrlChange,
  isFullUrl,
  onFullUrlChange,
  isEndpointModalOpen,
  onEndpointModalToggle,
  onCustomEndpointsChange,
  autoSelect,
  onAutoSelectChange,
  codexModel = "",
  onModelChange,
  apiFormat,
  onApiFormatChange,
  allowAutoApiFormat = false,
  anthropicAuthField,
  onAnthropicAuthFieldChange,
  impersonateClaudeCode,
  onImpersonateClaudeCodeChange,
  maxOutputTokens,
  onMaxOutputTokensChange,
  codexChatReasoning = {},
  onCodexChatReasoningChange,
  promptCacheRouting,
  onPromptCacheRoutingChange,
  catalogModels = [],
  onCatalogModelsChange,
  modelRoutes = {},
  onModelRoutesChange,
  speedTestEndpoints,
  customUserAgent,
  onCustomUserAgentChange,
  localProxyHeadersOverride,
  onLocalProxyHeadersOverrideChange,
  localProxyBodyOverride,
  onLocalProxyBodyOverrideChange,
}: CodexFormFieldsProps) {
  const { t } = useTranslation();
  const uid = useId();

  const [fetchedModels, setFetchedModels] = useState<FetchedModel[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  // 拉取请求序号：请求身份（Base URL / 完整地址开关 / API Key / 自定义 UA）
  // 一变即自增，清空旧列表并作废在途响应——/models 结果可能按 Key 的模型
  // 授权返回，换号后残留旧列表会误导选择
  const fetchModelsSeqRef = useRef(0);

  useEffect(() => {
    fetchModelsSeqRef.current += 1;
    setFetchedModels((prev) => (prev.length === 0 ? prev : []));
    setIsFetchingModels(false);
    return () => {
      fetchModelsSeqRef.current += 1;
    };
  }, [
    codexBaseUrl,
    isFullUrl,
    codexApiKey,
    customUserAgent,
    localProxyHeadersOverride,
    isXaiOauthPreset,
    isXaiOauthAuthenticated,
    selectedXaiAccountId,
  ]);
  // 思考能力随 Chat 格式显示（仅 Chat Completions 转换路径用得上）；模型映射常驻
  //（填了才生成 catalog）。两者都已与「路由接管」概念解耦。
  const isChatFormat = apiFormat === "openai_chat";
  const isAnthropicFormat = apiFormat === "anthropic";
  const canEditCatalog = Boolean(onCatalogModelsChange);
  const canEditReasoning = Boolean(onCodexChatReasoningChange);
  const supportsThinking =
    codexChatReasoning.supportsThinking === true ||
    codexChatReasoning.supportsEffort === true;
  const supportsEffort = codexChatReasoning.supportsEffort === true;

  // 高级区默认折叠，与其他线路编辑器一致；折叠时摘要列出已启用的项目。
  const hasRequestOverrides = Boolean(
    localProxyHeadersOverride.trim() || localProxyBodyOverride.trim(),
  );

  const [catalogRows, setCatalogRows] = useState<CodexCatalogRow[]>(() =>
    catalogModels.map((m) => createCatalogRow(m)),
  );

  // 记录上次发送给父组件的数据，避免重复触发
  const lastSentModelsRef = useRef<CodexCatalogModel[]>(catalogModels);

  // 父 → 子：仅当 prop 数据真的变化（预设切换 / 编辑加载）时才重建 rowId；
  // 同 shape 时保留现有 rowId，避免编辑过程中焦点丢失。
  useEffect(() => {
    setCatalogRows((current) => {
      if (catalogRowsMatchModels(current, catalogModels)) return current;
      return catalogModels.map((m) => createCatalogRow(m));
    });
    // 同步更新 ref，避免父组件传入新数据时子→父 effect 误判为本地修改
    lastSentModelsRef.current = catalogModels;
  }, [catalogModels]);

  // 子 → 父：rowId 是视图层概念，不应进入持久化数据；剥离后再回传。
  // 注意：依赖数组不包含 catalogModels，避免父→子更新触发子→父回调形成循环。
  useEffect(() => {
    if (!onCatalogModelsChange) return;
    const next: CodexCatalogModel[] = catalogRows.map(
      ({ rowId: _rowId, ...rest }) => rest,
    );
    // 只有当数据真的变化时才通知父组件
    if (catalogRowsMatchModels(catalogRows, lastSentModelsRef.current)) return;
    lastSentModelsRef.current = next;
    onCatalogModelsChange(next);
  }, [catalogRows, onCatalogModelsChange]);

  const handleReasoningThinkingChange = useCallback(
    (checked: boolean) => {
      if (!onCodexChatReasoningChange) return;
      onCodexChatReasoningChange({
        ...codexChatReasoning,
        supportsThinking: checked,
        supportsEffort: checked ? codexChatReasoning.supportsEffort : false,
      });
    },
    [codexChatReasoning, onCodexChatReasoningChange],
  );

  const handleReasoningEffortChange = useCallback(
    (checked: boolean) => {
      if (!onCodexChatReasoningChange) return;
      onCodexChatReasoningChange({
        ...codexChatReasoning,
        supportsThinking: checked ? true : codexChatReasoning.supportsThinking,
        supportsEffort: checked,
        effortParam: checked
          ? (codexChatReasoning.effortParam ?? "reasoning_effort")
          : "none",
      });
    },
    [codexChatReasoning, onCodexChatReasoningChange],
  );

  const handleFetchModels = useCallback(() => {
    // xAI OAuth 托管预设：不走 base_url + key 的 /models 探测，
    // 直接用托管账号 token 拉取（与 Claude 表单同一后端命令）
    if (isXaiOauthPreset) {
      if (!isXaiOauthAuthenticated) {
        toast.error(
          t("xaiOauth.loginRequired", {
            defaultValue: "请先登录 xAI 账号",
          }),
        );
        return;
      }
      const seq = ++fetchModelsSeqRef.current;
      setIsFetchingModels(true);
      fetchXaiOauthModels(selectedXaiAccountId ?? null)
        .then((models) => {
          if (seq !== fetchModelsSeqRef.current) return;
          setFetchedModels(models);
          if (models.length === 0) {
            toast.info(t("providerForm.fetchModelsEmpty"));
          } else {
            toast.success(
              t("providerForm.fetchModelsSuccess", { count: models.length }),
            );
          }
        })
        .catch((err) => {
          if (seq !== fetchModelsSeqRef.current) return;
          console.warn("[XaiOAuth] Failed to fetch models:", err);
          showFetchModelsError(err, t);
        })
        .finally(() => {
          if (seq === fetchModelsSeqRef.current) setIsFetchingModels(false);
        });
      return;
    }

    if (!codexBaseUrl || !codexApiKey) {
      showFetchModelsError(null, t, {
        hasApiKey: !!codexApiKey,
        hasBaseUrl: !!codexBaseUrl,
      });
      return;
    }
    const seq = ++fetchModelsSeqRef.current;
    setIsFetchingModels(true);
    fetchModelsForConfig(
      codexBaseUrl,
      codexApiKey,
      isFullUrl,
      undefined,
      customUserAgent,
      localProxyHeadersOverride,
    )
      .then((models) => {
        if (seq !== fetchModelsSeqRef.current) return;
        setFetchedModels(models);
        if (models.length === 0) {
          toast.info(t("providerForm.fetchModelsEmpty"));
        } else {
          toast.success(
            t("providerForm.fetchModelsSuccess", { count: models.length }),
          );
        }
      })
      .catch((err) => {
        if (seq !== fetchModelsSeqRef.current) return;
        console.warn("[ModelFetch] Failed:", err);
        showFetchModelsError(err, t);
      })
      .finally(() => {
        if (seq === fetchModelsSeqRef.current) setIsFetchingModels(false);
      });
  }, [
    codexBaseUrl,
    codexApiKey,
    isFullUrl,
    customUserAgent,
    localProxyHeadersOverride,
    isXaiOauthPreset,
    isXaiOauthAuthenticated,
    selectedXaiAccountId,
    t,
  ]);

  const handleAddCatalogRow = useCallback(() => {
    if (!onCatalogModelsChange) return;
    // New rows are text-only by default: an unknown custom model must never be
    // declared image-capable without an explicit user choice (see the toggle).
    setCatalogRows((current) => [
      ...current,
      createCatalogRow({ inputModalities: ["text"] }),
    ]);
  }, [onCatalogModelsChange]);

  const handleUpdateCatalogRow = useCallback(
    (index: number, patch: Partial<CodexCatalogModel>) => {
      // 模型名变化时，把已配置的独立上游线路跟随迁移到新模型名。
      if (patch.model !== undefined && onModelRoutesChange) {
        const previousModel = catalogRows[index]?.model.trim() ?? "";
        const nextModel = (patch.model ?? "").trim();
        if (
          previousModel &&
          previousModel !== nextModel &&
          modelRoutes[previousModel]
        ) {
          const nextRoutes = { ...modelRoutes };
          const moved = nextRoutes[previousModel];
          delete nextRoutes[previousModel];
          if (nextModel && !nextRoutes[nextModel]) {
            nextRoutes[nextModel] = moved;
          }
          onModelRoutesChange(nextRoutes);
        }
      }
      setCatalogRows((current) =>
        current.map((row, i) => (i === index ? { ...row, ...patch } : row)),
      );
    },
    [catalogRows, modelRoutes, onModelRoutesChange],
  );

  const handleRemoveCatalogRow = useCallback(
    (index: number) => {
      const model = catalogRows[index]?.model.trim();
      if (model && onModelRoutesChange && modelRoutes[model]) {
        const nextRoutes = { ...modelRoutes };
        delete nextRoutes[model];
        onModelRoutesChange(nextRoutes);
      }
      setCatalogRows((current) => current.filter((_, i) => i !== index));
    },
    [catalogRows, modelRoutes, onModelRoutesChange],
  );

  // 独立上游线路：每行一个可展开编辑器（手风琴式，同时最多展开一个）。
  const canEditRoutes = Boolean(onModelRoutesChange);
  const [routeEditorRowId, setRouteEditorRowId] = useState<string | null>(null);

  const patchRouteForModel = useCallback(
    (model: string, patch: Partial<CodexModelRoute> | null) => {
      if (!onModelRoutesChange) return;
      const key = model.trim();
      if (!key) return;
      const nextRoutes = { ...modelRoutes };
      if (patch === null) {
        delete nextRoutes[key];
      } else {
        nextRoutes[key] = { ...nextRoutes[key], ...patch };
      }
      onModelRoutesChange(nextRoutes);
    },
    [modelRoutes, onModelRoutesChange],
  );

  // 默认模型下拉建议 = 模型映射的"实际请求模型"列 ∪ 拉取到的 /models 列表
  const defaultModelSuggestions = useMemo<FetchedModel[]>(() => {
    const seen = new Set<string>();
    const suggestions: FetchedModel[] = [];
    for (const row of catalogRows) {
      const id = row.model.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      suggestions.push({
        id,
        ownedBy: t("codexConfig.modelMappingTitle", {
          defaultValue: "模型映射",
        }),
      });
    }
    for (const model of fetchedModels) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      suggestions.push(model);
    }
    return suggestions;
  }, [catalogRows, fetchedModels, t]);

  // 填了映射时才提示"默认模型不在映射中"（无映射的供应商本来就直接请求任意模型名）
  const trimmedDefaultModel = codexModel.trim();
  const isDefaultModelOutsideCatalog =
    catalogRows.length > 0 &&
    !!trimmedDefaultModel &&
    !catalogRows.some((row) => row.model.trim() === trimmedDefaultModel);

  const handleAddDefaultModelToCatalog = useCallback(() => {
    if (!onCatalogModelsChange || !trimmedDefaultModel) return;
    setCatalogRows((current) => [
      ...current,
      createCatalogRow({
        model: trimmedDefaultModel,
        displayName: trimmedDefaultModel,
        inputModalities: ["text"],
      }),
    ]);
  }, [onCatalogModelsChange, trimmedDefaultModel]);

  const renderCatalogActionButtons = (onAdd: () => void, addLabel: string) => (
    <div className="flex gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleFetchModels}
        disabled={isFetchingModels}
        className="h-7 gap-1"
      >
        {isFetchingModels ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Download className="h-3.5 w-3.5" />
        )}
        {t("providerForm.fetchModels")}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onAdd}
        className="h-7 gap-1"
      >
        <Plus className="h-3.5 w-3.5" />
        {addLabel}
      </Button>
    </div>
  );

  const advancedActive = [
    isAnthropicFormat && impersonateClaudeCode && "模拟 Claude Code",
    isAnthropicFormat && maxOutputTokens.trim() && "最大输出 tokens",
    isChatFormat && promptCacheRouting !== "auto" && "提示词缓存路由",
    isChatFormat && supportsThinking && "思考模式",
    isChatFormat && supportsEffort && "思考等级",
    catalogModels.length > 0 && "模型映射",
    customUserAgent.trim() && "自定义 User-Agent",
    hasRequestOverrides && "请求覆盖",
  ].filter((item): item is string => Boolean(item));
  const showFormat = shouldShowSpeedTest && !isXaiOauthPreset;
  const formatOptions = CODEX_FORMAT_CHOICES.filter(
    ([value]) => allowAutoApiFormat || value !== "auto",
  );
  const resolvedFormat: CodexApiFormat | null =
    apiFormat === "auto"
      ? trimmedDefaultModel
        ? codexApiFormatForModel(trimmedDefaultModel)
        : null
      : apiFormat;

  return (
    <>
      <section className="editor-basic" aria-labelledby={`${uid}-basic`}>
        <div className="editor-section-head">
          <h3 id={`${uid}-basic`}>基础</h3>
          {basicStatus}
        </div>
        <div className="editor-basic-grid">
          {basicLead}
          {/* Codex Base URL 输入框（托管 OAuth 端点由 adapter 硬定向，不展示） */}
          {shouldShowSpeedTest && !isXaiOauthPreset && (
            <EndpointField
              id="codexBaseUrl"
              label="API 请求地址"
              required
              value={codexBaseUrl}
              onChange={onBaseUrlChange}
              placeholder={t("providerForm.codexApiEndpointPlaceholder")}
              hint={
                appId === "codex" ? t("providerForm.codexApiHint") : undefined
              }
              help={addressHelp}
              showFullUrlToggle
              isFullUrl={isFullUrl}
              onFullUrlChange={onFullUrlChange}
              onManageClick={() => onEndpointModalToggle(true)}
            />
          )}

          {/* xAI OAuth 认证（Grok 订阅托管账号） */}
          {isXaiOauthPreset && (
            <XaiOAuthSection
              selectedAccountId={selectedXaiAccountId}
              onAccountSelect={onXaiAccountSelect}
            />
          )}

          {/* Codex API Key 输入框（托管 OAuth 预设无需 Key） */}
          {!isXaiOauthPreset && (
            <ApiKeySection
              id="codexApiKey"
              label={apiKeyRequired ? "API Key *" : "API Key"}
              value={codexApiKey}
              onChange={onApiKeyChange}
              category={category}
              shouldShowLink={shouldShowApiKeyLink}
              websiteUrl={websiteUrl}
              isPartner={isPartner}
              partnerPromotionKey={partnerPromotionKey}
              help={apiKeyHelp}
              placeholder={{
                official: t("providerForm.codexOfficialNoApiKey", {
                  defaultValue: "官方供应商无需 API Key",
                }),
                thirdParty:
                  appId === "codex"
                    ? t("providerForm.codexApiKeyAutoFill")
                    : t("providerForm.apiKeyAutoFill"),
              }}
            />
          )}
          {basicTail}
        </div>
      </section>

      {category !== "official" && (showFormat || onModelChange) && (
        <section
          className="editor-protocol"
          aria-labelledby={`${uid}-protocol`}
        >
          <div className="editor-section-head">
            <h3 id={`${uid}-protocol`}>协议与模型</h3>
            {protocolStatus}
          </div>
          {/* 上游格式 —— Chat 与 Anthropic Messages 经本地路由转换，Responses
              原生直连。沿用 shouldShowSpeedTest 门控，cloud_provider 保持不可
              切换；xAI OAuth 托管预设格式钉死 Responses，不可切换。 */}
          {showFormat && (
            <EditorChoice
              name={`${uid}-api-format`}
              label="协议"
              help={
                allowAutoApiFormat
                  ? "自动模式按模型族选择协议：GPT、o1/o3/o4、Codex 和 ChatGPT 使用 Responses；Claude 使用 Anthropic Messages；其他模型使用 Chat Completions。显式选择始终优先，保存时不发起探测请求。"
                  : "供应商原生是 Responses API 就选 Responses（直连，不转换格式）；使用 Chat Completions 协议就选 Chat；只提供 Anthropic Messages 协议就选 Anthropic Messages。"
              }
              value={apiFormat}
              options={formatOptions}
              onChange={onApiFormatChange}
            >
              <p className="editor-routing">
                {apiFormat === "auto" && (
                  <span>
                    {resolvedFormat
                      ? `按模型族推断为 ${CODEX_FORMAT_LABELS[resolvedFormat]}`
                      : "填写默认模型后按模型族推断协议"}
                  </span>
                )}
                {resolvedFormat && resolvedFormat !== "openai_responses" && (
                  <span>需开启路由接管，经本地路由转换为 Responses</span>
                )}
              </p>
            </EditorChoice>
          )}

          {/* 默认模型 —— config.toml 顶层 model，Codex 启动时默认请求的模型。
              实时写回 TOML；留空则删行（有映射时保存回退为映射第一行）。 */}
          {onModelChange && (
            <div className="editor-field editor-default-model">
              <EditorLabel
                htmlFor="codexDefaultModel"
                label={t("codexConfig.defaultModelLabel", {
                  defaultValue: "默认模型",
                })}
              />
              <div className="model-input">
                <input
                  id="codexDefaultModel"
                  value={codexModel}
                  onChange={(event) => onModelChange(event.target.value)}
                  placeholder={t("codexConfig.defaultModelPlaceholder", {
                    defaultValue: "例如: gpt-5.6",
                  })}
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={`${uid}-model-hint`}
                />
                <button
                  type="button"
                  onClick={handleFetchModels}
                  disabled={isFetchingModels}
                  title={t("providerForm.fetchModels", {
                    defaultValue: "获取模型列表",
                  })}
                >
                  {isFetchingModels ? (
                    <Loader2 className="spin" size={15} aria-hidden="true" />
                  ) : (
                    <Download size={15} aria-hidden="true" />
                  )}
                  获取模型
                </button>
                {defaultModelSuggestions.length > 0 && (
                  <ModelDropdown
                    variant="addon"
                    models={defaultModelSuggestions}
                    onSelect={(id) => onModelChange(id)}
                  />
                )}
              </div>
              <small id={`${uid}-model-hint`}>
                {appId === "grokbuild"
                  ? "Grok Build 默认请求的模型，请填写服务商支持的模型 ID。"
                  : t("codexConfig.defaultModelHint", {
                      defaultValue:
                        "Codex 默认请求的模型，随时可改，无需等待预设更新。留空且配置了模型映射时，默认使用映射第一行。",
                    })}
              </small>
              {isDefaultModelOutsideCatalog && (
                <p className="editor-model-notice">
                  <span>
                    {t("codexConfig.defaultModelNotInCatalog", {
                      defaultValue:
                        "该模型不在模型映射中，Codex 的 /model 菜单不会列出它（直接请求仍然有效）。",
                    })}
                  </span>
                  <button
                    type="button"
                    className="link-button"
                    onClick={handleAddDefaultModelToCatalog}
                  >
                    {t("codexConfig.addToModelMapping", {
                      defaultValue: "加入映射",
                    })}
                  </button>
                </p>
              )}
            </div>
          )}
        </section>
      )}

      {/* 高级配置 —— 认证方式、思考能力、模型映射与自定义 UA；预设供应商通常无需展开 */}
      {category !== "official" && (
        <EditorAdvanced
          summary={
            advancedActive.length
              ? `已启用：${advancedActive.join("、")}`
              : "思考能力 · User-Agent · 请求覆盖"
          }
        >
          {showFormat && isAnthropicFormat && (
            <div className="advanced-group">
              <div className="advanced-section-heading">
                <b>Anthropic Messages</b>
              </div>
              <EditorChoice
                name={`${uid}-anthropic-auth`}
                label="认证方式"
                help={ANTHROPIC_AUTH_HELP}
                value={anthropicAuthField}
                options={ANTHROPIC_AUTH_OPTIONS}
                onChange={onAnthropicAuthFieldChange}
              />
              <div className="toggle-list">
                <EditorToggle
                  name="codex-impersonate-claude-code"
                  role="switch"
                  label={t("codexConfig.impersonateClaudeCodeLabel", {
                    defaultValue: "模拟 Claude Code 客户端",
                  })}
                  help="伪装 User-Agent、anthropic-beta、x-app 请求头，并在系统提示首行注入 Claude Code 身份。"
                  note="只在网关或其上游限制只能通过 Claude Code 使用时开启。"
                  checked={impersonateClaudeCode}
                  onChange={onImpersonateClaudeCodeChange}
                />
              </div>
              <EditorField
                label={t("codexConfig.maxOutputTokensLabel", {
                  defaultValue: "最大输出 tokens",
                })}
                htmlFor="codex-anthropic-max-output-tokens"
                help="Codex 不会把 model_max_output_tokens 写进请求体，默认上限 8192 容易在长回答或深度思考时被截断（stop_reason=max_tokens）。这里的值会作为 Anthropic 的 max_tokens 覆盖请求值。"
                hint="留空使用默认 8192；不要超过该模型或网关的真实输出上限，否则可能返回 400。"
                hintId="codex-anthropic-max-output-tokens-hint"
              >
                <input
                  id="codex-anthropic-max-output-tokens"
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={maxOutputTokens}
                  aria-describedby="codex-anthropic-max-output-tokens-hint"
                  onChange={(event) =>
                    onMaxOutputTokensChange(
                      event.target.value.replace(/[^\d]/g, ""),
                    )
                  }
                  placeholder={t("codexConfig.maxOutputTokensPlaceholder", {
                    defaultValue: "留空则使用默认 8192",
                  })}
                />
              </EditorField>
            </div>
          )}

          {isChatFormat && canEditReasoning && (
            <div className="advanced-group">
              <div className="advanced-section-heading">
                <div>
                  <b>Chat Completions</b>
                  <small>
                    {t("codexConfig.reasoningSectionHint", {
                      defaultValue:
                        "预设供应商已自动配置；自定义供应商会按名称/地址自动推断。仅当自动识别不准时才需手动覆盖。",
                    })}
                  </small>
                </div>
              </div>
              <EditorChoice
                name={`${uid}-prompt-cache-routing`}
                label={t("codexConfig.promptCacheRoutingLabel", {
                  defaultValue: "提示词缓存路由",
                })}
                help={t("codexConfig.promptCacheRoutingHint", {
                  defaultValue:
                    "自动模式仅对已确认兼容的上游发送 prompt_cache_key；开启可用于其他兼容网关，关闭可避免严格网关因未知字段返回 400。只使用客户端提供的稳定会话 ID。",
                })}
                value={promptCacheRouting}
                options={PROMPT_CACHE_OPTIONS}
                onChange={onPromptCacheRoutingChange}
              />
              <div className="toggle-list">
                <EditorToggle
                  name="codex-supports-thinking"
                  role="switch"
                  label={t("codexConfig.reasoningModeToggle", {
                    defaultValue: "支持思考模式",
                  })}
                  note={t("codexConfig.reasoningModeHint", {
                    defaultValue:
                      "上游 Chat Completions 接口支持开启或关闭 thinking 时启用。Kimi、GLM、Qwen 等通常属于这一类。",
                  })}
                  checked={supportsThinking}
                  onChange={handleReasoningThinkingChange}
                />
                <EditorToggle
                  name="codex-supports-effort"
                  role="switch"
                  label={t("codexConfig.reasoningEffortToggle", {
                    defaultValue: "支持思考等级",
                  })}
                  note={t("codexConfig.reasoningEffortHint", {
                    defaultValue:
                      "上游支持 low/high/max 等思考深度控制时启用。启用后会自动启用思考模式，并把 Codex 的 reasoning.effort 转成上游 Chat 参数。",
                  })}
                  checked={supportsEffort}
                  onChange={handleReasoningEffortChange}
                />
              </div>
            </div>
          )}
          {/* 模型映射 / 模型目录 —— 与「路由接管」解耦，常驻显示（可编辑即渲染）。
                填了才生成 catalog：Chat 模式生成兼容路由、原生 Responses 生成
                model-catalogs.json；留空则不生成。排在自定义 UA 之前。 */}
          {canEditCatalog && (
            <div
              className={cn(
                "space-y-4",
                (shouldShowSpeedTest || (isChatFormat && canEditReasoning)) &&
                  "border-t border-border-default pt-3",
              )}
            >
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <FormLabel>
                    {t("codexConfig.modelMappingTitle", {
                      defaultValue: "模型映射",
                    })}
                  </FormLabel>
                  {renderCatalogActionButtons(
                    handleAddCatalogRow,
                    t("codexConfig.addCatalogModel", {
                      defaultValue: "添加模型",
                    }),
                  )}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("codexConfig.modelMappingHint", {
                    defaultValue:
                      "选择模型角色后，CC Switch 会自动生成 Codex 兼容路由；菜单显示名可以填 DeepSeek、Kimi 等品牌模型，实际请求模型按右侧填写内容发送。",
                  })}
                </p>
              </div>

              {catalogRows.length > 0 && (
                <div className="space-y-2">
                  {/* 列头：md+ 显示 */}
                  <div className="hidden grid-cols-[1fr_1fr_120px_110px_1fr_36px_36px] gap-2 px-1 text-xs font-medium text-muted-foreground md:grid">
                    <span>
                      {t("codexConfig.catalogColumnDisplay", {
                        defaultValue: "菜单显示名",
                      })}
                    </span>
                    <span>
                      {t("codexConfig.catalogColumnModel", {
                        defaultValue: "实际请求模型",
                      })}
                    </span>
                    <span>
                      {t("codexConfig.catalogColumnContext", {
                        defaultValue: "上下文窗口",
                      })}
                    </span>
                    <span>
                      {t("codexConfig.catalogColumnImage", {
                        defaultValue: "图片输入",
                      })}
                    </span>
                    <span>
                      {t("codexConfig.catalogColumnReasoning", {
                        defaultValue: "思考等级",
                      })}
                    </span>
                    <span />
                    <span />
                  </div>

                  {catalogRows.map((row, index) => (
                    <Fragment key={row.rowId}>
                      <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_1fr_120px_110px_1fr_36px_36px]">
                        <Input
                          value={row.displayName ?? ""}
                          onChange={(event) =>
                            handleUpdateCatalogRow(index, {
                              displayName: event.target.value,
                            })
                          }
                          placeholder={t(
                            "codexConfig.catalogDisplayNamePlaceholder",
                            {
                              defaultValue: "例如: DeepSeek V4 Flash",
                            },
                          )}
                          aria-label={t("codexConfig.catalogColumnDisplay", {
                            defaultValue: "菜单显示名",
                          })}
                        />
                        <div className="flex gap-1">
                          <Input
                            value={row.model}
                            onChange={(event) =>
                              handleUpdateCatalogRow(index, {
                                model: event.target.value,
                              })
                            }
                            placeholder={t(
                              "codexConfig.catalogModelPlaceholder",
                              {
                                defaultValue: "例如: deepseek-v4-flash",
                              },
                            )}
                            aria-label={t("codexConfig.catalogColumnModel", {
                              defaultValue: "实际请求模型",
                            })}
                            className="flex-1"
                          />
                          {fetchedModels.length > 0 && (
                            <ModelDropdown
                              models={fetchedModels}
                              onSelect={(id) =>
                                handleUpdateCatalogRow(index, {
                                  model: id,
                                  displayName: row.displayName?.trim()
                                    ? row.displayName
                                    : id,
                                })
                              }
                            />
                          )}
                        </div>
                        <Input
                          type="number"
                          min={1}
                          inputMode="numeric"
                          value={row.contextWindow ?? ""}
                          onChange={(event) =>
                            handleUpdateCatalogRow(index, {
                              contextWindow: event.target.value.replace(
                                /[^\d]/g,
                                "",
                              ),
                            })
                          }
                          placeholder={t(
                            "codexConfig.contextWindowPlaceholder",
                            {
                              defaultValue: "例如: 128000",
                            },
                          )}
                          aria-label={t("codexConfig.catalogColumnContext", {
                            defaultValue: "上下文窗口",
                          })}
                        />
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id={`catalog-image-${row.rowId}`}
                            checked={catalogRowSupportsImage(row)}
                            onCheckedChange={(checked: boolean) =>
                              handleUpdateCatalogRow(index, {
                                inputModalities:
                                  catalogInputModalities(checked),
                              })
                            }
                          />
                          <label
                            htmlFor={`catalog-image-${row.rowId}`}
                            className="text-xs text-muted-foreground"
                          >
                            {t("codexConfig.catalogColumnImage", {
                              defaultValue: "图片输入",
                            })}
                          </label>
                        </div>
                        <ReasoningLevelsEditor
                          levels={row.reasoningLevels}
                          defaultLevel={row.defaultReasoningLevel}
                          onLevelsChange={(levels) =>
                            handleUpdateCatalogRow(index, {
                              reasoningLevels: levels,
                            })
                          }
                          onDefaultLevelChange={(level) =>
                            handleUpdateCatalogRow(index, {
                              defaultReasoningLevel: level,
                            })
                          }
                        />
                        {canEditRoutes && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className={cn(
                              "h-9 w-9",
                              modelRoutes[row.model.trim()]
                                ? modelRoutes[row.model.trim()]?.enabled ===
                                  false
                                  ? "text-muted-foreground/60"
                                  : "text-primary"
                                : "text-muted-foreground",
                            )}
                            disabled={!row.model.trim()}
                            onClick={() =>
                              setRouteEditorRowId((current) =>
                                current === row.rowId ? null : row.rowId,
                              )
                            }
                            title={t("codexConfig.modelRouteToggle", {
                              defaultValue: "独立上游线路",
                            })}
                            aria-label={t("codexConfig.modelRouteToggle", {
                              defaultValue: "独立上游线路",
                            })}
                            aria-expanded={routeEditorRowId === row.rowId}
                          >
                            <Route className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 text-muted-foreground hover:text-destructive"
                          onClick={() => handleRemoveCatalogRow(index)}
                          title={t("common.delete", { defaultValue: "删除" })}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      {canEditRoutes &&
                        routeEditorRowId === row.rowId &&
                        row.model.trim() && (
                          <div className="space-y-2 rounded-md border border-border-default bg-muted/30 p-3">
                            <div className="flex items-center justify-between">
                              <p className="text-xs font-medium">
                                {t("codexConfig.modelRouteTitle", {
                                  defaultValue: "独立上游线路：{{model}}",
                                  model: row.model.trim(),
                                })}
                              </p>
                              <div className="flex items-center gap-2">
                                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                                  <Switch
                                    checked={
                                      modelRoutes[row.model.trim()]?.enabled !==
                                      false
                                    }
                                    onCheckedChange={(checked: boolean) =>
                                      patchRouteForModel(row.model, {
                                        enabled: checked ? undefined : false,
                                      })
                                    }
                                    aria-label={t(
                                      "codexConfig.modelRouteEnabled",
                                      { defaultValue: "启用线路" },
                                    )}
                                  />
                                  {t("codexConfig.modelRouteEnabled", {
                                    defaultValue: "启用线路",
                                  })}
                                </label>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                                  onClick={() => {
                                    patchRouteForModel(row.model, null);
                                    setRouteEditorRowId(null);
                                  }}
                                >
                                  {t("codexConfig.modelRouteRemove", {
                                    defaultValue: "移除线路",
                                  })}
                                </Button>
                              </div>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {t("codexConfig.modelRouteHint", {
                                defaultValue:
                                  "该模型的请求将发往下面的独立上游；留空的字段沿用本线路的默认配置。",
                              })}
                            </p>
                            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                              <Input
                                value={
                                  modelRoutes[row.model.trim()]?.baseUrl ?? ""
                                }
                                onChange={(event) =>
                                  patchRouteForModel(row.model, {
                                    baseUrl: event.target.value || undefined,
                                  })
                                }
                                placeholder={t(
                                  "codexConfig.modelRouteBaseUrlPlaceholder",
                                  {
                                    defaultValue:
                                      "上游地址，例如 https://api.example.com/v1",
                                  },
                                )}
                                aria-label={t("codexConfig.modelRouteBaseUrl", {
                                  defaultValue: "线路上游地址",
                                })}
                              />
                              <Input
                                type="password"
                                autoComplete="off"
                                value={
                                  modelRoutes[row.model.trim()]?.apiKey ?? ""
                                }
                                onChange={(event) =>
                                  patchRouteForModel(row.model, {
                                    apiKey: event.target.value || undefined,
                                  })
                                }
                                placeholder={t(
                                  "codexConfig.modelRouteApiKeyPlaceholder",
                                  {
                                    defaultValue: "线路 API Key（可选）",
                                  },
                                )}
                                aria-label={t("codexConfig.modelRouteApiKey", {
                                  defaultValue: "线路 API Key",
                                })}
                              />
                            </div>
                            <div className="flex flex-wrap items-center gap-3">
                              <Select
                                value={
                                  modelRoutes[row.model.trim()]?.apiFormat ??
                                  "inherit"
                                }
                                onValueChange={(value) =>
                                  patchRouteForModel(row.model, {
                                    apiFormat:
                                      value === "inherit"
                                        ? undefined
                                        : (value as CodexApiFormat),
                                  })
                                }
                              >
                                <SelectTrigger className="w-56">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="inherit">
                                    {t("codexConfig.modelRouteFormatInherit", {
                                      defaultValue: "协议：按模型族默认",
                                    })}
                                  </SelectItem>
                                  <SelectItem value="openai_responses">
                                    OpenAI Responses
                                  </SelectItem>
                                  <SelectItem value="openai_chat">
                                    OpenAI Chat Completions
                                  </SelectItem>
                                  <SelectItem value="anthropic">
                                    Anthropic Messages
                                  </SelectItem>
                                </SelectContent>
                              </Select>
                              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                <Checkbox
                                  checked={
                                    modelRoutes[row.model.trim()]?.isFullUrl ===
                                    true
                                  }
                                  onCheckedChange={(checked: boolean) =>
                                    patchRouteForModel(row.model, {
                                      isFullUrl: checked ? true : undefined,
                                    })
                                  }
                                />
                                {t("codexConfig.modelRouteFullUrl", {
                                  defaultValue: "地址为完整 API 端点",
                                })}
                              </label>
                            </div>
                          </div>
                        )}
                    </Fragment>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="advanced-group">
            <div className="advanced-section-heading">
              <b>兼容性</b>
            </div>
            <CustomUserAgentField
              id="codex-custom-user-agent"
              value={customUserAgent}
              onChange={onCustomUserAgentChange}
            />
            <LocalProxyRequestOverridesField
              headersJson={localProxyHeadersOverride}
              bodyJson={localProxyBodyOverride}
              onHeadersJsonChange={onLocalProxyHeadersOverrideChange}
              onBodyJsonChange={onLocalProxyBodyOverrideChange}
            />
          </div>
        </EditorAdvanced>
      )}

      {/* 端点测速弹窗 - Codex */}
      {shouldShowSpeedTest && isEndpointModalOpen && (
        <EndpointSpeedTest
          appId={appId}
          providerId={providerId}
          value={codexBaseUrl}
          onChange={onBaseUrlChange}
          initialEndpoints={speedTestEndpoints}
          visible={isEndpointModalOpen}
          onClose={() => onEndpointModalToggle(false)}
          autoSelect={autoSelect}
          onAutoSelectChange={onAutoSelectChange}
          onCustomEndpointsChange={onCustomEndpointsChange}
        />
      )}
    </>
  );
}
