import { getChimeraHubTemplate } from "@/config/codexTemplates";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Download, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@/components/ui/form";
import {
  EditorChoice,
  EditorToggle,
  OneMCheck,
  ROUTED_PROTOCOL_NOTE,
  SectionStatus,
  type EditorChoiceOption,
} from "@/components/providers/ProviderEditorFields";
import { HelpTip } from "@/components/ui/help-tip";
import { BasicFormFields, MoreInfoFields } from "./BasicFormFields";
import { CodexOAuthSection } from "./CodexOAuthSection";
import { CopilotAuthSection } from "./CopilotAuthSection";
import { XaiOAuthSection } from "./XaiOAuthSection";
import { ApiKeySection } from "./shared/ApiKeySection";
import { EndpointField } from "./shared/EndpointField";
import { ModelDropdown } from "./shared/ModelDropdown";
import { ProviderPresetSelector } from "./ProviderPresetSelector";
import { useApiKeyLink } from "./hooks/useApiKeyLink";
import { providerSchema, type ProviderFormData } from "@/lib/schemas/provider";
import type {
  ClaudeApiFormat,
  ClaudeDesktopModelRoute,
  ProviderCategory,
  ProviderMeta,
} from "@/types";

import {
  CLAUDE_DESKTOP_ROLE_ROUTE_IDS,
  claudeDesktopProviderPresets,
  type ClaudeDesktopProviderPreset,
  type ClaudeDesktopRoleId,
} from "@/config/claudeDesktopProviderPresets";
import {
  fetchModelsForConfig,
  showFetchModelsError,
  type FetchedModel,
} from "@/lib/api/model-fetch";
import {
  providersApi,
  type ClaudeDesktopDefaultRoute,
} from "@/lib/api/providers";
import { resolveManagedAccountId } from "@/lib/authBinding";
import { useCopilotAuth, useCodexOauth, useXaiOauth } from "./hooks";
import { isOAuthProviderType } from "@/config/constants";

export type ClaudeDesktopProviderFormValues = ProviderFormData & {
  presetId?: string;
  presetCategory?: ProviderCategory;
  isPartner?: boolean;
  partnerPromotionKey?: string;
  meta?: ProviderMeta;
  providerKey?: string;
};

type ApiKeyField = "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY";

type PresetEntry = {
  id: string;
  preset: ClaudeDesktopProviderPreset;
};

export interface ClaudeDesktopProviderFormProps {
  submitLabel: string;
  onSubmit: (values: ClaudeDesktopProviderFormValues) => Promise<void> | void;
  onCancel: () => void;
  onSubmittingChange?: (isSubmitting: boolean) => void;
  onDirtyChange?: () => void;
  /** The line name as typed, for the editor header. */
  onNameChange?: (name: string) => void;
  /** The request address as typed (null when the line has none). */
  onBaseUrlChange?: (url: string | null) => void;
  initialData?: {
    name?: string;
    websiteUrl?: string;
    notes?: string;
    settingsConfig?: Record<string, unknown>;
    category?: ProviderCategory;
    meta?: ProviderMeta;
    icon?: string;
    iconColor?: string;
  };
  showButtons?: boolean;
}

type RouteRow = {
  rowId: string;
  route: string;
  model: string;
  labelOverride: string;
  supports1m: boolean;
};

type RouteRowValues = Omit<RouteRow, "rowId">;
type RouteRole = ClaudeDesktopRoleId;

const CLAUDE_ROUTE_PREFIX = "claude-";
const ANTHROPIC_CLAUDE_ROUTE_PREFIX = "anthropic/claude-";
const LEGACY_ONE_M_MARKER = "[1m]";
const ROLE_ROUTE_IDS = CLAUDE_DESKTOP_ROLE_ROUTE_IDS;
const ROLE_ORDER: RouteRole[] = ["sonnet", "opus", "fable", "haiku"];

// The protocol control of the line editors, in their order; the note is
// read as each option's description.
const DESKTOP_FORMAT_CHOICES: ReadonlyArray<
  EditorChoiceOption<ClaudeApiFormat>
> = [
  ["openai_responses", "Responses", ROUTED_PROTOCOL_NOTE],
  ["openai_chat", "Chat Completions", ROUTED_PROTOCOL_NOTE],
  ["anthropic", "Anthropic Messages", "Claude Desktop 原生协议"],
  ["gemini_native", "Gemini", ROUTED_PROTOCOL_NOTE],
];

function envString(
  settingsConfig: Record<string, unknown> | undefined,
  key: string,
) {
  const env = settingsConfig?.env;
  if (!env || typeof env !== "object") return "";
  const value = (env as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function clonePlainRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

function routeRoleFromId(route: string): RouteRole {
  const normalized = route.trim().toLowerCase();
  // 与后端 claude_role_keyword 同序（opus → haiku → fable → sonnet）。
  if (normalized.includes("opus")) return "opus";
  if (normalized.includes("haiku")) return "haiku";
  if (normalized.includes("fable")) return "fable";
  return "sonnet";
}

function routeIdForRole(role: RouteRole, usedRoutes: Set<string>) {
  const baseRoute = ROLE_ROUTE_IDS[role];
  if (!usedRoutes.has(baseRoute)) return baseRoute;

  let index = 2;
  while (usedRoutes.has(`${baseRoute}-r${index}`)) {
    index += 1;
  }
  return `${baseRoute}-r${index}`;
}

function fallbackCatalogRouteId(usedRoutes: Set<string>) {
  const role = ROLE_ORDER.find((candidate) => {
    const route = ROLE_ROUTE_IDS[candidate];
    return !usedRoutes.has(route);
  });
  return routeIdForRole(role ?? "sonnet", usedRoutes);
}

function createRouteRow(row: RouteRowValues): RouteRow {
  return {
    rowId: crypto.randomUUID(),
    ...row,
  };
}

function initialRouteRows(
  routes: Record<string, ClaudeDesktopModelRoute> | undefined,
): RouteRow[] {
  const usedRoutes = new Set(
    Object.keys(routes ?? {}).filter((route) => isClaudeSafeRoute(route)),
  );

  return Object.entries(routes ?? {}).map(([route, value]) => {
    const routeId = isClaudeSafeRoute(route)
      ? route
      : fallbackCatalogRouteId(usedRoutes);
    usedRoutes.add(routeId);

    return createRouteRow({
      route: routeId,
      model: value.model ?? "",
      labelOverride:
        value.labelOverride ??
        (!isClaudeSafeRoute(route) ? value.model || route : ""),
      supports1m: value.supports1m ?? false,
    });
  });
}

// Proxy 模式对齐 Claude Code：固定 Sonnet / Opus / Fable / Haiku 四档。
// 把任意来源的 route 行按角色归类到固定四槽（缺档留空），保证 UI 永远四行、
// 用户不会漏配某档导致子 agent 找不到模型。
// （fable 自 Desktop 1.12603.1+ 起被 fail-all 校验放行，可作为独立档位。）
function normalizeProxyRows(rows: RouteRow[]): RouteRow[] {
  return ROLE_ORDER.map((role) => {
    const match = rows.find(
      (row) => row.route.trim() && routeRoleFromId(row.route) === role,
    );
    return createRouteRow({
      route: ROLE_ROUTE_IDS[role],
      model: match?.model ?? "",
      labelOverride: match?.labelOverride ?? "",
      supports1m: match?.supports1m ?? false,
    });
  });
}

function isClaudeSafeRoute(route: string) {
  const normalized = route.trim().toLowerCase();
  if (normalized.includes(LEGACY_ONE_M_MARKER)) return false;
  const routeTail = normalized.startsWith(ANTHROPIC_CLAUDE_ROUTE_PREFIX)
    ? normalized.slice(ANTHROPIC_CLAUDE_ROUTE_PREFIX.length)
    : normalized.startsWith(CLAUDE_ROUTE_PREFIX)
      ? normalized.slice(CLAUDE_ROUTE_PREFIX.length)
      : "";

  // 角色前缀后必须还有实际模型标识，拒绝 claude-sonnet- 这类退化值
  // （否则会写入 profile 并触发 Claude Desktop fail-all 拒收整组）。
  // 与后端 is_claude_safe_model_id 镜像；fable 自 Desktop 1.12603.1+ 起被校验放行。
  return ["sonnet-", "opus-", "haiku-", "fable-"].some(
    (prefix) =>
      routeTail.startsWith(prefix) && routeTail.length > prefix.length,
  );
}

function defaultRouteRows(
  defaults: ClaudeDesktopDefaultRoute[],
  defaultModel: string,
): RouteRow[] {
  return defaults.map((route, index) =>
    createRouteRow({
      route: route.routeId,
      model: index === 0 ? defaultModel : "",
      labelOverride: "",
      supports1m: route.supports1m,
    }),
  );
}

export function ClaudeDesktopProviderForm({
  submitLabel,
  onSubmit,
  onCancel,
  onSubmittingChange,
  onDirtyChange,
  onNameChange,
  onBaseUrlChange,
  initialData,
  showButtons = true,
}: ClaudeDesktopProviderFormProps) {
  const { t } = useTranslation();
  const initialMode = isOAuthProviderType(initialData?.meta?.providerType)
    ? "proxy"
    : (initialData?.meta?.claudeDesktopMode ??
      (initialData ? "direct" : "proxy"));
  const [mode, setMode] = useState<"direct" | "proxy">(initialMode);
  const [apiFormat, setApiFormat] = useState<ClaudeApiFormat>(
    initialData?.meta?.apiFormat ??
      (initialData ? "anthropic" : "openai_responses"),
  );
  const [baseUrl, setBaseUrl] = useState(
    initialData
      ? envString(initialData.settingsConfig, "ANTHROPIC_BASE_URL")
      : getChimeraHubTemplate().baseUrl,
  );
  const [apiKey, setApiKey] = useState(
    envString(initialData?.settingsConfig, "ANTHROPIC_AUTH_TOKEN") ||
      envString(initialData?.settingsConfig, "ANTHROPIC_API_KEY"),
  );
  const [apiKeyField, setApiKeyField] = useState<ApiKeyField>(() =>
    envString(initialData?.settingsConfig, "ANTHROPIC_API_KEY")
      ? "ANTHROPIC_API_KEY"
      : "ANTHROPIC_AUTH_TOKEN",
  );
  const [selectedGitHubAccountId, setSelectedGitHubAccountId] = useState<
    string | null
  >(() => resolveManagedAccountId(initialData?.meta, "github_copilot"));
  const [selectedCodexAccountId, setSelectedCodexAccountId] = useState<
    string | null
  >(() => resolveManagedAccountId(initialData?.meta, "codex_oauth"));
  const [selectedXaiAccountId, setSelectedXaiAccountId] = useState<
    string | null
  >(() => resolveManagedAccountId(initialData?.meta, "xai_oauth"));
  const [codexFastMode, setCodexFastMode] = useState<boolean>(
    () => initialData?.meta?.codexFastMode ?? false,
  );
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(
    initialData ? null : "claude-desktop-0",
  );
  const [activePreset, setActivePreset] = useState<{
    id: string;
    category?: ProviderCategory;
    isPartner?: boolean;
    partnerPromotionKey?: string;
    providerType?: string;
    requiresOAuth?: boolean;
  } | null>(null);
  const [routes, setRoutes] = useState<RouteRow[]>(() => {
    const rows = initialData
      ? initialRouteRows(initialData.meta?.claudeDesktopModelRoutes)
      : (claudeDesktopProviderPresets[0].modelRoutes ?? []).map((r) =>
          createRouteRow({
            route: r.routeId,
            model: r.upstreamModel,
            labelOverride: r.labelOverride ?? "",
            supports1m: r.supports1m,
          }),
        );
    // proxy 模式归一化成固定三档；但初始无任何 route 时保持空数组，交给 seed
    // effect 用默认路由回填（默认 1M 声明、ANTHROPIC_MODEL 预填），避免过早
    // normalize 成空三档把 routes.length 撑到 3、永久挡住 seed。
    return initialMode === "proxy" && rows.length > 0
      ? normalizeProxyRows(rows)
      : rows;
  });
  const didSeedDefaultRoutes = useRef(
    Object.keys(initialData?.meta?.claudeDesktopModelRoutes ?? {}).length > 0,
  );
  const [fetchedModels, setFetchedModels] = useState<FetchedModel[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [directModelsExpanded, setDirectModelsExpanded] = useState(
    initialMode === "direct" &&
      Object.keys(initialData?.meta?.claudeDesktopModelRoutes ?? {}).length > 0,
  );
  const { data: defaultRoutes = [] } = useQuery({
    queryKey: ["claudeDesktopDefaultRoutes"],
    queryFn: () => providersApi.getClaudeDesktopDefaultRoutes(),
  });
  const defaultProxyRouteRows = useMemo(
    () =>
      defaultRouteRows(
        defaultRoutes,
        envString(initialData?.settingsConfig, "ANTHROPIC_MODEL"),
      ),
    [defaultRoutes, initialData?.settingsConfig],
  );

  const defaultValues: ProviderFormData = useMemo(
    () => ({
      name: initialData?.name ?? getChimeraHubTemplate().name,
      websiteUrl: initialData?.websiteUrl ?? "",
      notes: initialData?.notes ?? "",
      settingsConfig: JSON.stringify(
        initialData?.settingsConfig ?? { env: {} },
        null,
        2,
      ),
      icon: initialData?.icon ?? "",
      iconColor: initialData?.iconColor ?? "",
    }),
    [initialData],
  );

  const form = useForm<ProviderFormData>({
    resolver: zodResolver(providerSchema),
    defaultValues,
    mode: "onSubmit",
  });

  useEffect(() => {
    onSubmittingChange?.(form.formState.isSubmitting || isFetchingModels);
  }, [form.formState.isSubmitting, isFetchingModels, onSubmittingChange]);
  const watchedName = form.watch("name");
  useEffect(() => {
    onNameChange?.(watchedName ?? "");
  }, [watchedName, onNameChange]);

  const draftState = JSON.stringify([
    mode,
    apiFormat,
    baseUrl,
    apiKey,
    apiKeyField,
    selectedGitHubAccountId,
    selectedCodexAccountId,
    selectedXaiAccountId,
    codexFastMode,
    routes,
    activePreset,
  ]);
  const previousDraftState = useRef(draftState);
  useEffect(() => {
    if (previousDraftState.current !== draftState) {
      previousDraftState.current = draftState;
      onDirtyChange?.();
    }
  }, [draftState, onDirtyChange]);

  const presetEntries = useMemo<PresetEntry[]>(
    () =>
      claudeDesktopProviderPresets.map((preset, index) => ({
        id: `claude-desktop-${index}`,
        preset,
      })),
    [],
  );

  const presetCategoryLabels: Record<string, string> = useMemo(
    () => ({
      official: t("providerForm.categoryOfficial", { defaultValue: "官方" }),
      cn_official: t("providerForm.categoryCnOfficial", {
        defaultValue: "国内官方",
      }),
      aggregator: t("providerForm.categoryAggregation", {
        defaultValue: "聚合服务",
      }),
      third_party: t("providerForm.categoryThirdParty", {
        defaultValue: "第三方",
      }),
    }),
    [t],
  );
  const activeProviderType =
    activePreset?.providerType ?? initialData?.meta?.providerType;
  const { isAuthenticated: isCopilotAuthenticated, accounts: copilotAccounts } =
    useCopilotAuth();
  const {
    isAuthenticated: isCodexOauthAuthenticated,
    accounts: codexOauthAccounts,
  } = useCodexOauth();
  const {
    isAuthenticated: isXaiOauthAuthenticated,
    accounts: xaiOauthAccounts,
  } = useXaiOauth();
  const isOfficial =
    initialData?.category === "official" ||
    activePreset?.category === "official";
  const usesManagedOAuth =
    activePreset?.requiresOAuth === true ||
    isOAuthProviderType(activeProviderType);
  const effectiveMode: "direct" | "proxy" = usesManagedOAuth ? "proxy" : mode;
  const needsModelMapping = effectiveMode === "proxy";
  useEffect(() => {
    onBaseUrlChange?.(isOfficial ? null : baseUrl);
  }, [baseUrl, isOfficial, onBaseUrlChange]);

  // API Key 获取/邀请链接（与 Claude Code 表单同款，见 ClaudeFormFields）
  const apiKeyLinkCategory = activePreset?.category ?? initialData?.category;
  const {
    shouldShowApiKeyLink,
    websiteUrl: apiKeyLinkWebsiteUrl,
    isPartner: apiKeyLinkIsPartner,
    partnerPromotionKey: apiKeyLinkPromotionKey,
  } = useApiKeyLink({
    appId: "claude-desktop",
    category: apiKeyLinkCategory,
    selectedPresetId,
    presetEntries,
    formWebsiteUrl: form.watch("websiteUrl") || "",
  });

  const applyDesktopPreset = (preset: ClaudeDesktopProviderPreset) => {
    form.setValue("name", preset.nameKey ? t(preset.nameKey) : preset.name);
    form.setValue("websiteUrl", preset.websiteUrl);
    form.setValue("notes", "");
    form.setValue("icon", preset.icon ?? "");
    form.setValue("iconColor", preset.iconColor ?? "");

    setBaseUrl(preset.baseUrl);
    setApiKey("");
    setApiKeyField(preset.apiKeyField ?? "ANTHROPIC_AUTH_TOKEN");
    setApiFormat(preset.apiFormat ?? "anthropic");

    const presetMode =
      preset.requiresOAuth === true || isOAuthProviderType(preset.providerType)
        ? "proxy"
        : preset.mode;
    didSeedDefaultRoutes.current = true;
    setMode(presetMode);
    if (presetMode === "proxy" && preset.modelRoutes) {
      setRoutes(
        normalizeProxyRows(
          preset.modelRoutes.map((r) =>
            createRouteRow({
              route: r.routeId,
              model: r.upstreamModel,
              labelOverride: r.labelOverride ?? "",
              supports1m: r.supports1m,
            }),
          ),
        ),
      );
    } else {
      setRoutes([]);
    }
  };

  const handlePresetChange = (value: string) => {
    setSelectedPresetId(value);

    if (value === "custom") {
      setActivePreset(null);
      form.reset(defaultValues);
      setBaseUrl("");
      setApiKey("");
      setApiKeyField("ANTHROPIC_AUTH_TOKEN");
      setApiFormat("anthropic");
      didSeedDefaultRoutes.current = false;
      setMode("direct");
      setRoutes([]);
      return;
    }

    const entry = presetEntries.find((item) => item.id === value);
    if (!entry) return;

    setActivePreset({
      id: value,
      category: entry.preset.category,
      isPartner: entry.preset.isPartner,
      partnerPromotionKey: entry.preset.partnerPromotionKey,
      providerType: entry.preset.providerType,
      requiresOAuth: entry.preset.requiresOAuth,
    });
    applyDesktopPreset(entry.preset);
  };

  const updateRoute = (index: number, patch: Partial<RouteRowValues>) => {
    setRoutes((current) =>
      current.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  };

  const handleModelMappingChange = (checked: boolean) => {
    if (usesManagedOAuth) return;
    setMode(checked ? "proxy" : "direct");
    if (checked) {
      // 切到 proxy：归一化成固定 Sonnet / Opus / Haiku 三档；
      // 若当前无路由则以后端默认路由作为来源（保留 Sonnet 默认模型）。
      setRoutes((current) => {
        // 默认路由（默认 1M 声明、ANTHROPIC_MODEL 预填）异步加载完成前，若当前
        // 无路由则保持空数组，交给 seed effect 在加载后回填；不要过早 normalize
        // 成空三档（会把 routes.length 撑到 3、永久挡住 seed）。
        if (current.length === 0 && defaultProxyRouteRows.length === 0) {
          return current;
        }
        const useDefaults =
          current.length === 0 && defaultProxyRouteRows.length > 0;
        if (useDefaults) {
          didSeedDefaultRoutes.current = true;
        }
        return normalizeProxyRows(
          useDefaults ? defaultProxyRouteRows : current,
        );
      });
    }
  };

  useEffect(() => {
    if (
      didSeedDefaultRoutes.current ||
      effectiveMode !== "proxy" ||
      routes.length > 0 ||
      defaultProxyRouteRows.length === 0
    ) {
      return;
    }

    didSeedDefaultRoutes.current = true;
    setRoutes(normalizeProxyRows(defaultProxyRouteRows));
  }, [defaultProxyRouteRows, effectiveMode, routes.length]);

  const handleFetchModels = async () => {
    if (!baseUrl.trim() || !apiKey.trim()) {
      showFetchModelsError(null, t, {
        hasBaseUrl: Boolean(baseUrl.trim()),
        hasApiKey: Boolean(apiKey.trim()),
      });
      return;
    }

    setIsFetchingModels(true);
    try {
      const models = await fetchModelsForConfig(baseUrl.trim(), apiKey.trim());
      setFetchedModels(models);
      toast.success(
        t("providerForm.fetchModelsSuccess", {
          count: models.length,
          defaultValue: `已获取 ${models.length} 个模型`,
        }),
      );
    } catch (error) {
      showFetchModelsError(error, t, {
        hasBaseUrl: Boolean(baseUrl.trim()),
        hasApiKey: Boolean(apiKey.trim()),
      });
    } finally {
      setIsFetchingModels(false);
    }
  };

  const handleSubmit = async (values: ProviderFormData) => {
    if (!values.name.trim()) {
      toast.error(
        t("providerForm.fillSupplierName", {
          defaultValue: "请填写供应商名称",
        }),
      );
      return;
    }
    if (isOfficial) {
      // 官方供应商使用 Claude Desktop 内置 1P 模式，保持空 env 占位；
      // 不写 claudeDesktopMode / claudeDesktopModelRoutes / apiFormat，
      // 与启动 seed 的 OFFICIAL_SEEDS 占位语义一致。
      const settingsConfig = clonePlainRecord(initialData?.settingsConfig);
      settingsConfig.env = {};
      const meta: ProviderMeta = { ...(initialData?.meta ?? {}) };
      delete meta.claudeDesktopMode;
      delete meta.claudeDesktopModelRoutes;
      delete meta.apiFormat;
      delete meta.endpointAutoSelect;
      delete meta.isFullUrl;
      await onSubmit({
        ...values,
        name: values.name.trim(),
        websiteUrl: values.websiteUrl?.trim() ?? "",
        notes: values.notes?.trim() ?? "",
        settingsConfig: JSON.stringify(settingsConfig, null, 2),
        meta,
        presetId: activePreset?.id,
        presetCategory: "official",
      });
      return;
    }
    if (!baseUrl.trim() && !usesManagedOAuth) {
      toast.error(
        t("providerForm.fetchModelsNeedEndpoint", {
          defaultValue: "请先填写接口地址",
        }),
      );
      return;
    }
    const selectedAccountIsUsable = (
      accountId: string | null,
      accounts: Array<{ id: string; requires_reauth: boolean }>,
    ) =>
      accountId === null ||
      accounts.some(
        (account) => account.id === accountId && !account.requires_reauth,
      );
    const managedAuthState =
      activeProviderType === "github_copilot"
        ? {
            authenticated: isCopilotAuthenticated,
            accountId: selectedGitHubAccountId,
            accounts: copilotAccounts,
            loginMessage: t("copilot.loginRequired", {
              defaultValue: "请先登录 GitHub Copilot",
            }),
          }
        : activeProviderType === "codex_oauth"
          ? {
              authenticated: isCodexOauthAuthenticated,
              accountId: selectedCodexAccountId,
              accounts: codexOauthAccounts,
              loginMessage: t("codexOauth.loginRequired", {
                defaultValue: "请先登录 ChatGPT 账号",
              }),
            }
          : activeProviderType === "xai_oauth"
            ? {
                authenticated: isXaiOauthAuthenticated,
                accountId: selectedXaiAccountId,
                accounts: xaiOauthAccounts,
                loginMessage: t("xaiOauth.loginRequired", {
                  defaultValue: "请先登录 xAI 账号",
                }),
              }
            : null;
    if (managedAuthState && !managedAuthState.authenticated) {
      toast.error(managedAuthState.loginMessage);
      return;
    }
    if (
      managedAuthState &&
      !selectedAccountIsUsable(
        managedAuthState.accountId,
        managedAuthState.accounts,
      )
    ) {
      toast.error(
        t("managedAuth.selectedAccountUnavailable", {
          defaultValue: "已绑定账号不存在或需要重新登录，请重新选择账号",
        }),
      );
      return;
    }
    if (!usesManagedOAuth && !apiKey.trim()) {
      toast.error(
        t("providerForm.fetchModelsNeedApiKey", {
          defaultValue: "请先填写 API Key",
        }),
      );
      return;
    }

    const routeEntries = routes
      .map((route) => ({
        ...route,
        route: route.route.trim(),
        model: route.model.trim(),
        labelOverride: route.labelOverride.trim(),
      }))
      .filter((route) => route.route || route.model);

    if (effectiveMode === "proxy") {
      // 固定四档（Sonnet / Opus / Fable / Haiku），route_id 由 UI 生成、恒合法，
      // 因此只要求至少填一个实际请求模型；留空档继承第一个已填档（Sonnet 优先），
      // 对齐 Claude Code 的兜底，保证落库四档齐全、子 agent 不会找不到模型。
      const primary = routeEntries.find((route) => route.model);
      if (!primary) {
        toast.error(
          t("claudeDesktop.routesRequired", {
            defaultValue: "至少填写一个模型映射",
          }),
        );
        return;
      }
      for (const route of routeEntries) {
        if (!route.model) {
          route.model = primary.model;
          if (!route.labelOverride) {
            route.labelOverride = primary.labelOverride || primary.model;
          }
          // 回填的是同一个上游模型，1M 能力声明应与 primary 一致，
          // 避免同模型在不同档声明不同 1M（除非该档用户已显式勾选）。
          if (!route.supports1m) {
            route.supports1m = primary.supports1m;
          }
        }
      }
    } else {
      const invalid = routeEntries.find(
        (route) => !route.route || !isClaudeSafeRoute(route.route),
      );
      if (invalid) {
        toast.error(
          t("claudeDesktop.directModelInvalid", {
            defaultValue:
              "直连模型必须使用 Claude Desktop 可识别的 Sonnet / Opus / Haiku 模型名",
          }),
        );
        return;
      }
    }

    const settingsConfig = clonePlainRecord(initialData?.settingsConfig);
    const env = clonePlainRecord(settingsConfig.env);
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
    settingsConfig.env = usesManagedOAuth
      ? {
          ...env,
          ANTHROPIC_BASE_URL: baseUrl.trim().replace(/\/+$/, ""),
        }
      : {
          ...env,
          ANTHROPIC_BASE_URL: baseUrl.trim().replace(/\/+$/, ""),
          [apiKeyField]: apiKey.trim(),
        };

    const routeMap = routeEntries.reduce<
      Record<string, ClaudeDesktopModelRoute>
    >((acc, route) => {
      acc[route.route] = {
        model:
          effectiveMode === "direct" ? route.route : route.model || route.route,
        labelOverride:
          route.labelOverride ||
          (effectiveMode === "proxy" ? route.model : undefined),
        supports1m: route.supports1m || undefined,
      };
      return acc;
    }, {});

    const meta: ProviderMeta = {
      ...(initialData?.meta ?? {}),
      claudeDesktopMode: effectiveMode,
      apiFormat:
        activeProviderType === "xai_oauth"
          ? "openai_responses"
          : effectiveMode === "proxy"
            ? apiFormat
            : "anthropic",
    };

    meta.claudeDesktopModelRoutes = routeMap;
    meta.providerType = activeProviderType;
    meta.authBinding =
      activeProviderType === "github_copilot"
        ? {
            source: "managed_account",
            authProvider: "github_copilot",
            accountId: selectedGitHubAccountId ?? undefined,
          }
        : activeProviderType === "codex_oauth"
          ? {
              source: "managed_account",
              authProvider: "codex_oauth",
              accountId: selectedCodexAccountId ?? undefined,
            }
          : activeProviderType === "xai_oauth"
            ? {
                source: "managed_account",
                authProvider: "xai_oauth",
                accountId: selectedXaiAccountId ?? undefined,
              }
            : undefined;
    meta.codexFastMode =
      activeProviderType === "codex_oauth" ? codexFastMode : undefined;

    delete meta.endpointAutoSelect;
    delete meta.isFullUrl;

    await onSubmit({
      ...values,
      name: values.name.trim(),
      websiteUrl: values.websiteUrl?.trim() ?? "",
      notes: values.notes?.trim() ?? "",
      settingsConfig: JSON.stringify(settingsConfig, null, 2),
      meta,
      presetId: activePreset?.id,
      presetCategory: activePreset?.category,
      isPartner: activePreset?.isPartner,
      partnerPromotionKey: activePreset?.partnerPromotionKey,
    });
  };

  const fetchModelsButton = !usesManagedOAuth && (
    <button
      type="button"
      className="secondary compact"
      onClick={handleFetchModels}
      disabled={isFetchingModels}
    >
      {isFetchingModels ? (
        <Loader2 className="spin" size={14} aria-hidden="true" />
      ) : (
        <Download size={14} aria-hidden="true" />
      )}
      {t("providerForm.fetchModels", { defaultValue: "获取模型" })}
    </button>
  );
  const basicMissing = [
    watchedName,
    ...(isOfficial || usesManagedOAuth ? [] : [baseUrl, apiKey]),
  ].filter((value) => !value?.trim()).length;
  const protocolMissing =
    needsModelMapping && !routes.some((route) => route.model.trim()) ? 1 : 0;

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
            presetEntries={presetEntries}
            presetCategoryLabels={presetCategoryLabels}
            onPresetChange={handlePresetChange}
            category={activePreset?.category}
          />
        )}

        <section className="editor-basic" aria-labelledby="desktop-basic">
          <div className="editor-section-head">
            <h3 id="desktop-basic">基础</h3>
            <SectionStatus missing={basicMissing} />
          </div>
          <div className="editor-basic-grid">
            <BasicFormFields form={form} />

            {isOfficial && (
              <p className="editor-model-notice">
                {t("claudeDesktop.officialNotice", {
                  defaultValue:
                    "Claude Desktop 官方供应商使用应用内置的 1P 登录，无需配置 API Key 和接口地址。",
                })}
              </p>
            )}

            {!isOfficial && (
              <EndpointField
                id="baseUrl"
                label="API 请求地址"
                required={!usesManagedOAuth}
                value={baseUrl}
                onChange={(v) => setBaseUrl(v)}
                placeholder={t("providerForm.apiEndpointPlaceholder")}
                hint={
                  needsModelMapping && apiFormat === "openai_responses"
                    ? t("providerForm.apiHintResponses")
                    : needsModelMapping && apiFormat === "openai_chat"
                      ? t("providerForm.apiHintOAI")
                      : needsModelMapping && apiFormat === "gemini_native"
                        ? t("providerForm.apiHintGeminiNative")
                        : t("providerForm.apiHint")
                }
                help="不需要模型映射时，Claude Desktop 在这个地址后拼接 /v1/messages；需要模型映射时，本地路由按所选协议转发到这个地址。"
                showManageButton={false}
              />
            )}

            {!isOfficial &&
              (usesManagedOAuth ? (
                <div className="editor-managed-auth">
                  {activeProviderType === "github_copilot" ? (
                    <CopilotAuthSection
                      selectedAccountId={selectedGitHubAccountId}
                      onAccountSelect={setSelectedGitHubAccountId}
                    />
                  ) : activeProviderType === "codex_oauth" ? (
                    <CodexOAuthSection
                      selectedAccountId={selectedCodexAccountId}
                      onAccountSelect={setSelectedCodexAccountId}
                      fastModeEnabled={codexFastMode}
                      onFastModeChange={setCodexFastMode}
                    />
                  ) : (
                    <XaiOAuthSection
                      selectedAccountId={selectedXaiAccountId}
                      onAccountSelect={setSelectedXaiAccountId}
                    />
                  )}
                </div>
              ) : (
                <ApiKeySection
                  label="API Key *"
                  value={apiKey}
                  onChange={setApiKey}
                  category={apiKeyLinkCategory}
                  shouldShowLink={shouldShowApiKeyLink}
                  websiteUrl={apiKeyLinkWebsiteUrl}
                  isPartner={apiKeyLinkIsPartner}
                  partnerPromotionKey={apiKeyLinkPromotionKey}
                  help="密钥只保存在本机，写入 Claude Desktop 的第三方接入配置。"
                />
              ))}
            <MoreInfoFields form={form} />
          </div>
        </section>

        {!isOfficial && (
          <section className="editor-protocol" aria-labelledby="desktop-models">
            <div className="editor-section-head">
              <h3 id="desktop-models">协议与模型</h3>
              <SectionStatus missing={protocolMissing} />
            </div>

            <div className="toggle-list editor-toggle-card">
              <EditorToggle
                name="claude-desktop-model-mapping"
                role="switch"
                label={t("claudeDesktop.modelMappingToggle", {
                  defaultValue: "需要模型映射",
                })}
                note={
                  needsModelMapping
                    ? t("claudeDesktop.modelMappingOnHint", {
                        defaultValue:
                          "将 Desktop 角色映射到上游模型，使用期间需保持本地路由开启。",
                      })
                    : t("claudeDesktop.modelMappingOffHint", {
                        defaultValue:
                          "上游模型名与 Desktop 角色不一致时，请开启映射。",
                      })
                }
                checked={needsModelMapping}
                disabled={usesManagedOAuth}
                onChange={handleModelMappingChange}
              />
            </div>

            {needsModelMapping && activeProviderType !== "xai_oauth" && (
              <EditorChoice
                name="claude-desktop-api-format"
                label="协议"
                help="Anthropic Messages 是 Claude Desktop 的原生协议；其余协议由本地路由转换，使用期间需保持 Chimera++ 运行。"
                value={apiFormat}
                options={DESKTOP_FORMAT_CHOICES}
                onChange={setApiFormat}
              />
            )}

            {needsModelMapping && (
              <div className="advanced-group model-mapping">
                <div className="advanced-section-heading">
                  <span className="editor-field-label">
                    <b>
                      {t("claudeDesktop.routeMapTitle", {
                        defaultValue: "模型映射",
                      })}
                    </b>
                    <HelpTip title="模型映射说明">
                      {t("claudeDesktop.routeMapHint", {
                        defaultValue:
                          "填写实际模型 ID；空白角色沿用 Sonnet 或首个已填模型。",
                      })}
                      勾选 1M 会向 Claude Desktop 声明这个模型支持 1M 上下文。
                    </HelpTip>
                  </span>
                  <span className="mapping-heading-actions">
                    {fetchModelsButton}
                  </span>
                </div>
                {routes.length > 0 && (
                  <div className="mapping-head is-tiers" aria-hidden="true">
                    <span>档位</span>
                    <span>菜单显示名（可选）</span>
                    <span>
                      {t("claudeDesktop.upstreamModelLabel", {
                        defaultValue: "实际请求模型",
                      })}
                    </span>
                    <span>
                      {t("claudeDesktop.supports1mLabel", {
                        defaultValue: "声明支持 1M",
                      })}
                    </span>
                  </div>
                )}
                {routes.map((route, index) => {
                  const role = routeRoleFromId(route.route);
                  const roleLabel =
                    role === "opus"
                      ? t("claudeDesktop.routeRoleOpus", {
                          defaultValue: "Opus",
                        })
                      : role === "haiku"
                        ? t("claudeDesktop.routeRoleHaiku", {
                            defaultValue: "Haiku",
                          })
                        : role === "fable"
                          ? t("claudeDesktop.routeRoleFable", {
                              defaultValue: "Fable",
                            })
                          : t("claudeDesktop.routeRoleSonnet", {
                              defaultValue: "Sonnet",
                            });
                  // Haiku 档示范映射到轻量模型（flash），其余档映射到 pro；
                  // 两列占位联动，保持每行「菜单显示名 ↔ 实际请求模型」品牌一致。
                  const isHaikuRole = role === "haiku";
                  const labelPlaceholder = isHaikuRole
                    ? "DeepSeek V4 Flash"
                    : "DeepSeek V4 Pro";
                  const modelPlaceholder = isHaikuRole
                    ? "deepseek-v4-flash"
                    : "deepseek-v4-pro";
                  return (
                    <div key={route.rowId} className="mapping-row is-tiers">
                      <span className="mapping-role">{roleLabel}</span>
                      <input
                        aria-label={`${roleLabel} 菜单显示名`}
                        value={route.labelOverride}
                        onChange={(event) =>
                          updateRoute(index, {
                            labelOverride: event.target.value,
                          })
                        }
                        placeholder={labelPlaceholder}
                        autoComplete="off"
                      />
                      <div className="model-input">
                        <input
                          aria-label={`${roleLabel} 实际请求模型`}
                          value={route.model}
                          onChange={(event) =>
                            updateRoute(index, { model: event.target.value })
                          }
                          placeholder={modelPlaceholder}
                          autoComplete="off"
                          spellCheck={false}
                        />
                        {fetchedModels.length > 0 && (
                          <ModelDropdown
                            variant="addon"
                            models={fetchedModels}
                            onSelect={(id) =>
                              updateRoute(index, {
                                model: id,
                                labelOverride: route.labelOverride || id,
                              })
                            }
                          />
                        )}
                      </div>
                      <OneMCheck
                        label={roleLabel}
                        checked={route.supports1m}
                        onChange={(supports1m) =>
                          updateRoute(index, { supports1m })
                        }
                      />
                    </div>
                  );
                })}
              </div>
            )}

            {!needsModelMapping && (
              <details
                className="chimera-disclosure is-inline"
                open={directModelsExpanded}
                onToggle={(event) =>
                  setDirectModelsExpanded(event.currentTarget.open)
                }
              >
                <summary>
                  {t("claudeDesktop.directModelListTitle", {
                    defaultValue: "手动模型列表（可选）",
                  })}
                  {!directModelsExpanded && (
                    <small>
                      {t("claudeDesktop.directModelListCollapsedHint", {
                        defaultValue: "默认从 /v1/models 自动读取。",
                      })}
                    </small>
                  )}
                </summary>
                <div className="chimera-disclosure-body advanced-group model-mapping">
                  <div className="advanced-section-heading">
                    <small>
                      {t("claudeDesktop.directModelListHint", {
                        defaultValue:
                          "仅当供应商的 /v1/models 不可用或没有返回 Claude Desktop 可识别的 Sonnet / Opus / Haiku 模型名时填写；勾选 1M 会向 Claude Desktop 声明支持 1M 上下文。",
                      })}
                    </small>
                    <span className="mapping-heading-actions">
                      {fetchModelsButton}
                      <button
                        type="button"
                        className="secondary compact"
                        onClick={() =>
                          setRoutes((current) => [
                            ...current,
                            createRouteRow({
                              route: "",
                              model: "",
                              labelOverride: "",
                              supports1m: false,
                            }),
                          ])
                        }
                      >
                        <Plus size={14} aria-hidden="true" />
                        {t("claudeDesktop.addModel", {
                          defaultValue: "添加模型",
                        })}
                      </button>
                    </span>
                  </div>

                  {routes.map((route, index) => (
                    <div key={route.rowId} className="mapping-row is-direct">
                      <div className="model-input">
                        <input
                          aria-label={`模型 ${index + 1} ID`}
                          value={route.route}
                          onChange={(event) =>
                            updateRoute(index, {
                              route: event.target.value,
                            })
                          }
                          placeholder="claude-sonnet-4-6"
                          autoComplete="off"
                          spellCheck={false}
                        />
                        {fetchedModels.length > 0 && (
                          <ModelDropdown
                            variant="addon"
                            models={fetchedModels}
                            onSelect={(id) => updateRoute(index, { route: id })}
                          />
                        )}
                      </div>
                      <OneMCheck
                        label={`模型 ${index + 1}`}
                        checked={route.supports1m}
                        onChange={(supports1m) =>
                          updateRoute(index, { supports1m })
                        }
                      />
                      <button
                        type="button"
                        className="icon-button mapping-delete"
                        aria-label={`删除模型 ${index + 1}`}
                        title={t("common.delete", { defaultValue: "删除" })}
                        onClick={() =>
                          setRoutes((current) =>
                            current.filter((_, i) => i !== index),
                          )
                        }
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </section>
        )}

        {!isOfficial && (
          <FormField
            control={form.control}
            name="settingsConfig"
            render={() => (
              <FormItem className="space-y-0">
                <FormControl>
                  <input type="hidden" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {showButtons && (
          <div className="editor-save-actions">
            <button type="button" className="secondary" onClick={onCancel}>
              {t("common.cancel", { defaultValue: "取消" })}
            </button>
            <button
              type="submit"
              className="primary"
              disabled={form.formState.isSubmitting}
            >
              {submitLabel}
            </button>
          </div>
        )}
      </form>
    </Form>
  );
}
