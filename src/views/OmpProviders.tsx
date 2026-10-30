import { createPortal } from "react-dom";
import {
  ChevronLeft,
  Eye,
  EyeOff,
  Info,
  Loader2,
  Pencil,
  RefreshCw,
  Plus,
  Trash2,
} from "lucide-react";
import { OmpModelPicker } from "./OmpModelPicker";
import { getChimeraHubTemplate } from "@/config/codexTemplates";
import { useContext, useEffect, useRef, useState } from "react";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import { LineBadge } from "@/components/LineBadge";
import {
  EditorAdvanced,
  EditorChoice,
  EditorField,
  EditorSaveActions,
  EditorSaveSummary,
  EditorSelect,
  EditorTemplateCard,
  EditorTestAction,
  SaveLabel,
  SectionStatus,
  inUseNoticeText,
  previewOrigin,
  useAddressTest,
  type EditorChoiceOption,
} from "@/components/providers/ProviderEditorFields";
import { ToolPageActiveContext } from "@/components/RetainedToolPage";
import "@/components/ProviderEditorPage.css";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";
import { ompApi, ompApis } from "@/lib/api/omp";
import type { PiDocument } from "@/lib/api/pi";

type ObjectValue = Record<string, unknown>;
/** Prefix of the save error for a models.yml a rewrite would lose parts of. */
const LOSSY_REWRITE_CODE = "OMP_LOSSY_REWRITE";
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
// Names for OMP's `api` values: full names in the editor, the short protocol
// names of the Codex 线路 table in the route list (raw value in the tooltip).
const apiLabels: Record<string, string> = {
  "openai-completions": "Chat Completions",
  "openai-responses": "Responses",
  "anthropic-messages": "Anthropic Messages",
  "google-generative-ai": "Gemini",
};
const apiShortLabels: Record<string, string> = {
  "openai-completions": "Chat",
  "openai-responses": "Responses",
  "anthropic-messages": "Anthropic",
  "google-generative-ai": "Gemini",
};
// The protocols every line editor offers, in their order; OMP's other
// schema values sit behind 其他.
const STANDARD_APIS: EditorChoiceOption<string>[] = [
  ["openai-responses", "Responses"],
  ["openai-completions", "Chat Completions"],
  ["anthropic-messages", "Anthropic Messages"],
  ["google-generative-ai", "Gemini"],
];
const OTHER_API = "__other__";
const TOOL_NAME = "oh-my-pi";
const AUTH_OPTIONS = [
  ["apiKey", "API Key / 环境变量"],
  ["none", "免认证（本地服务）"],
  ["oauth", "已有 OAuth 授权"],
] as const;

/** 保存详情's model row: the first ID and how many more. */
function draftModelsSummary(models: string): string {
  const ids = models
    .split("\n")
    .map((id) => id.trim())
    .filter(Boolean);
  if (!ids.length) return "内置模型覆盖";
  return ids.length > 1 ? `${ids[0]} 等 ${ids.length} 个` : ids[0];
}

interface Draft {
  original: string | null;
  id: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  auth: string;
  models: string;
}

export function OmpProviders({
  native,
  actionsHost,
}: {
  native: boolean;
  actionsHost?: HTMLDivElement | null;
}) {
  const pageActive = useContext(ToolPageActiveContext);
  const [document, setDocument] = useState<PiDocument | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState("");
  // Whether a page-level error came from reading the file or from a write
  // (deleting a line); edit failures stay inside the open editor.
  const [errorSource, setErrorSource] = useState<"read" | "write">("read");
  const [notice, setNotice] = useState("");
  // The file has comments or anchors the rewrite would lose: the save waits
  // for an explicit second confirmation (`deleteId` repeats a removal).
  const [lossyRetry, setLossyRetry] = useState<{ deleteId?: string } | null>(
    null,
  );
  const [pending, setPending] = useState<
    "save" | "discard" | "reload" | "restore" | { delete: string } | null
  >(null);
  const { connection, test, reset } = useAddressTest();
  useEffect(() => {
    reset();
  }, [draft?.baseUrl, reset]);
  useLightweightCloseBlocker(busy || draft !== null);
  const providers = object(document?.value.providers);
  const load = async () => {
    if (!native || running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const loaded = await ompApi.read();
      if (
        !loaded ||
        !loaded.value ||
        typeof loaded.value !== "object" ||
        Array.isArray(loaded.value) ||
        typeof loaded.path !== "string" ||
        typeof loaded.revision !== "string"
      )
        throw new Error("OMP 配置返回格式无效，请确认桌面端已更新");
      setDocument(loaded);
      setDraft(null);
    } catch (e) {
      setErrorSource("read");
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, [native]); // Config is re-read only on explicit refresh.

  const edit = (id: string | null) => {
    const provider = id === null ? {} : object(providers[id]);
    setError("");
    setNotice("");
    setShowKey(false);
    setDirty(false);
    setDraft({
      original: id,
      id: id ?? "",
      baseUrl:
        id === null ? getChimeraHubTemplate().baseUrl : text(provider.baseUrl),
      api: text(provider.api) || (id === null ? "openai-completions" : ""),
      apiKey: text(provider.apiKey),
      auth: text(provider.auth),
      models: Array.isArray(provider.models)
        ? provider.models.map((m) => text(object(m).id)).join("\n")
        : "",
    });
  };
  const build = (): ObjectValue => {
    if (!draft || !document) throw new Error("请先读取线路配置");
    const id = draft.original ?? draft.id.trim();
    if (!id || /[\x00-\x1f\x7f]/.test(id)) throw new Error("请填写有效线路 ID");
    if (draft.original === null && Object.hasOwn(providers, id))
      throw new Error("线路 ID 已存在");
    const original =
      draft.original === null ? {} : object(providers[draft.original]);
    const provider = { ...original };
    for (const key of ["baseUrl", "api", "apiKey", "auth"] as const) {
      const value = draft[key].trim();
      if (value) provider[key] = value;
      else delete provider[key];
    }
    if (draft.api.trim() && !ompApis.includes(draft.api.trim()))
      throw new Error("请选择支持的 API 协议");
    const ids = draft.models
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (new Set(ids).size !== ids.length) throw new Error("模型 ID 不可重复");
    if (ids.length) {
      if (!draft.baseUrl.trim()) throw new Error("请填写 API 地址");
      let url: URL;
      try {
        url = new URL(draft.baseUrl.trim());
      } catch {
        throw new Error("API 地址格式无效");
      }
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error("API 地址须为不含账号密码的 HTTP(S) 地址");
      if (!draft.apiKey.trim() && !["none", "oauth"].includes(draft.auth))
        throw new Error("请填写密钥 / 环境变量名，或选择免认证");
      const previous = Array.isArray(original.models) ? original.models : [];
      provider.models = ids.map(
        (id) => previous.find((m) => object(m).id === id) ?? { id },
      );
      if (
        !draft.api.trim() &&
        (provider.models as unknown[]).some((m) => !text(object(m).api))
      )
        throw new Error("请填写 API 协议");
    } else if (Object.hasOwn(original, "models")) provider.models = [];
    if (
      !ids.length &&
      !draft.baseUrl.trim() &&
      !draft.apiKey.trim() &&
      draft.auth !== "none" &&
      ![
        "headers",
        "compat",
        "modelOverrides",
        "discovery",
        "disableStrictTools",
        "guardrailIdentifier",
        "requestMetadata",
        "remoteCompaction",
      ].some((k) => k in provider)
    )
      throw new Error("请至少填写地址、密钥或模型配置");
    return { ...document.value, providers: { ...providers, [id]: provider } };
  };
  const save = async (deleteId?: string, allowLossyRewrite = false) => {
    if (!document || !native || running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      let value: ObjectValue;
      if (deleteId !== undefined) {
        const next = { ...providers };
        delete next[deleteId];
        value = { ...document.value, providers: next };
      } else value = build();
      setDocument(
        allowLossyRewrite
          ? await ompApi.save(value, document, true)
          : await ompApi.save(value, document),
      );
      setDraft(null);
      setPending(null);
      setLossyRetry(null);
      setNotice(
        deleteId !== undefined
          ? "线路已删除。"
          : "线路已保存。请在 OMP 中重新加载并选择模型。",
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setPending(null);
      setLossyRetry(null);
      if (!allowLossyRewrite && message.startsWith(LOSSY_REWRITE_CODE)) {
        setLossyRetry({ deleteId });
        return;
      }
      setErrorSource("write");
      setError(message);
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const field = (key: keyof Draft, value: string) => {
    setDirty(true);
    setDraft((current) => (current ? { ...current, [key]: value } : null));
  };
  const requestClose = () => {
    if (busy || pending) return;
    if (dirty) setPending("discard");
    else setDraft(null);
  };
  const needsEndpoint = Boolean(draft?.models.trim());
  const basicMissing = draft
    ? [
        draft.original === null ? draft.id : "-",
        needsEndpoint ? draft.baseUrl : "-",
        needsEndpoint && !["none", "oauth"].includes(draft.auth)
          ? draft.apiKey
          : "-",
      ].filter((value) => !value.trim()).length
    : 0;
  const protocolMissing = needsEndpoint && !draft?.api.trim() ? 1 : 0;
  const standardApi = STANDARD_APIS.some(([value]) => value === draft?.api);
  const otherApiOptions: [string, string][] = [
    ["", "不指定，沿用模型自身的协议"],
    ...(draft?.api && !ompApis.includes(draft.api)
      ? [[draft.api, draft.api] as [string, string]]
      : []),
    ...ompApis
      .filter((api) => !STANDARD_APIS.some(([value]) => value === api))
      .map((api) => [api, apiLabels[api] ?? api] as [string, string]),
  ];
  const actions = (
    <>
      <button
        type="button"
        className="tool-btn"
        disabled={!native || busy}
        onClick={() => (draft ? setPending("reload") : void load())}
      >
        <RefreshCw
          size={14}
          aria-hidden="true"
          className={busy ? "animate-spin" : ""}
        />
        刷新线路
      </button>
      {!draft && (
        <button
          type="button"
          className="tool-btn is-primary"
          disabled={!native || busy || !document}
          onClick={() => edit(null)}
        >
          <Plus size={15} aria-hidden="true" />
          添加线路
        </button>
      )}
    </>
  );
  return (
    <section className="tool-section-content" aria-label="OMP 模型线路">
      {actionsHost ? (
        createPortal(actions, actionsHost)
      ) : (
        <div className="tool-actions">{actions}</div>
      )}
      {!native && (
        <p className="tool-install-note">请在桌面应用中管理本地线路。</p>
      )}
      {/* The first read fills the page; later operations keep the list in
          place and only announce themselves (the header button spins). */}
      {busy &&
        (document ? (
          <p role="status" className="sr-only">
            正在处理线路配置…
          </p>
        ) : (
          <div role="status" className="tool-loading">
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            正在读取线路配置…
          </div>
        ))}
      {error && !draft && (
        <div className="tool-load-error" role="alert">
          <div className="tool-load-error-head">
            <strong>
              {errorSource === "read" ? "读取 oh-my-pi 配置失败" : "线路未删除"}
            </strong>
            <button
              type="button"
              className="tool-btn"
              disabled={!native || busy}
              onClick={() => void load()}
            >
              <RefreshCw
                size={14}
                aria-hidden="true"
                className={busy ? "animate-spin" : ""}
              />
              {errorSource === "read" ? "重试" : "刷新线路"}
            </button>
          </div>
          <p>
            {errorSource === "read"
              ? "请按下方提示修正配置文件或稍后重试；读取失败不会修改任何配置。"
              : "配置可能已被其他程序修改。请刷新线路，确认最新内容后再操作。"}
          </p>
          <pre>{error}</pre>
        </div>
      )}
      {notice && (
        <p role="status" className="tool-notice">
          {notice}
        </p>
      )}
      {draft ? (
        <FullScreenPanel
          isOpen={pageActive}
          title={`${draft.original === null ? "添加" : "编辑"} Oh My Pi 线路`}
          onClose={requestClose}
          editorHeader={
            <>
              <button
                type="button"
                className="secondary editor-back"
                aria-label="返回线路"
                disabled={busy}
                onClick={requestClose}
              >
                <ChevronLeft size={16} /> 线路
              </button>
              <div className="editor-heading">
                <h2>{draft.id.trim() || "未命名线路"}</h2>
                <span>
                  Oh My Pi · {draft.original === null ? "新建线路" : "编辑线路"}
                </span>
              </div>
              <span className="editor-draft-status" role="status">
                {busy ? "正在保存…" : dirty ? "未保存修改" : ""}
              </span>
              {draft.original !== null && (
                <button
                  type="button"
                  className="danger"
                  disabled={busy || !native}
                  onClick={() =>
                    draft.original !== null &&
                    setPending({ delete: draft.original })
                  }
                >
                  <Trash2 size={15} aria-hidden="true" /> 删除线路
                </button>
              )}
            </>
          }
          footer={
            <>
              <EditorTestAction
                connection={connection}
                onTest={() => void test(draft.baseUrl)}
                disabled={busy}
              />
              <EditorSaveActions
                note="保存后在 OMP 中重新加载并选择模型"
                onCancel={requestClose}
                disabled={busy}
              >
                <button
                  type="submit"
                  className="primary"
                  form="omp-provider-form"
                  disabled={busy}
                >
                  <SaveLabel busy={busy} label="保存线路" />
                </button>
              </EditorSaveActions>
            </>
          }
        >
          {/* oh-my-pi loads every line in models.yml, so a saved line is
              always in use: saving it rewrites the live config. */}
          {draft.original !== null && (
            <p className="editor-model-notice" role="note">
              <Info size={15} aria-hidden="true" />
              <span className="editor-in-use-text">
                {inUseNoticeText(TOOL_NAME, document?.path?.trim() || null)}
              </span>
            </p>
          )}
          <form
            id="omp-provider-form"
            aria-label="编辑 OMP 线路"
            onSubmit={(e) => {
              e.preventDefault();
              try {
                build();
                setError("");
                setPending("save");
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
            className="editor-form"
          >
            {error && (
              <p className="editor-feedback" role="alert">
                {error}
              </p>
            )}
            <fieldset className="editor-form" disabled={busy}>
              <legend className="sr-only">线路配置</legend>
              {draft.original === null && (
                <EditorTemplateCard
                  name={getChimeraHubTemplate().name}
                  onRestore={() => setPending("restore")}
                />
              )}
              <section
                className="editor-basic"
                aria-labelledby="omp-basic-title"
              >
                <div className="editor-section-head">
                  <h3 id="omp-basic-title">基础</h3>
                  <SectionStatus missing={basicMissing} />
                </div>
                <div className="editor-basic-grid">
                  <EditorField
                    label="线路 ID *"
                    htmlFor="omp-line-id"
                    hint="OMP 配置中的唯一标识；保存后不可修改，不是显示名称。"
                    hintId="omp-line-id-hint"
                  >
                    <input
                      id="omp-line-id"
                      aria-describedby="omp-line-id-hint"
                      autoComplete="off"
                      spellCheck={false}
                      value={draft.id}
                      disabled={draft.original !== null}
                      placeholder="例如 chimera"
                      onChange={(e) => field("id", e.target.value)}
                    />
                  </EditorField>
                  <EditorField
                    label={`API 请求地址${needsEndpoint ? " *" : ""}`}
                    htmlFor="omp-base-url"
                    help="oh-my-pi 在这个地址后拼接所选协议的请求路径，例如 Chat Completions 拼接 /chat/completions。"
                    hint="填写服务商的完整基础地址；配置自定义模型时必填。"
                    hintId="omp-base-url-hint"
                  >
                    <input
                      id="omp-base-url"
                      aria-describedby="omp-base-url-hint"
                      autoComplete="off"
                      spellCheck={false}
                      value={draft.baseUrl}
                      placeholder="https://api.example.com/v1"
                      onChange={(e) => field("baseUrl", e.target.value)}
                    />
                  </EditorField>
                  <EditorField
                    label="API Key / 环境变量名"
                    htmlFor="omp-api-key"
                    help="可填写密钥或已在 oh-my-pi 运行环境设置的变量名；本页不会创建环境变量。"
                  >
                    <div className="password-field">
                      <input
                        id="omp-api-key"
                        type={showKey ? "text" : "password"}
                        autoComplete="new-password"
                        spellCheck={false}
                        value={draft.apiKey}
                        placeholder="推荐填写环境变量名"
                        onChange={(e) => field("apiKey", e.target.value)}
                      />
                      <button
                        type="button"
                        aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                        onClick={() => setShowKey(!showKey)}
                      >
                        {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </EditorField>
                </div>
              </section>
              <section
                className="editor-protocol"
                aria-labelledby="omp-protocol-title"
              >
                <div className="editor-section-head">
                  <h3 id="omp-protocol-title">协议与模型</h3>
                  <SectionStatus missing={protocolMissing} />
                </div>
                <EditorChoice
                  name="omp-api"
                  label="协议"
                  help="自定义模型按这个协议请求上游；不指定时沿用每个模型自己的协议。"
                  value={standardApi ? draft.api : OTHER_API}
                  options={[...STANDARD_APIS, [OTHER_API, "其他"]]}
                  onChange={(value) =>
                    field(
                      "api",
                      value !== OTHER_API
                        ? value
                        : standardApi
                          ? ""
                          : draft.api,
                    )
                  }
                >
                  {!standardApi && (
                    <EditorSelect
                      label="其他协议"
                      value={draft.api}
                      onChange={(value) => field("api", value)}
                      options={otherApiOptions}
                    />
                  )}
                </EditorChoice>
                <OmpModelPicker
                  baseUrl={draft.baseUrl}
                  apiKey={draft.apiKey}
                  api={draft.api}
                  auth={draft.auth}
                  value={draft.models}
                  onChange={(value) => field("models", value)}
                />
                <EditorField
                  label="已选模型（可手动补充，每行一个）"
                  htmlFor="omp-models"
                  hint="同 ID 模型的高级参数会保留；移除 ID 将移除该模型配置。覆盖内置服务商时可以留空。"
                >
                  <textarea
                    id="omp-models"
                    aria-label="模型 ID"
                    rows={3}
                    value={draft.models}
                    placeholder="model-id"
                    onChange={(e) => field("models", e.target.value)}
                  />
                </EditorField>
              </section>
              <EditorAdvanced
                summary={`认证方式：${
                  AUTH_OPTIONS.find(
                    ([value]) => value === (draft.auth || "apiKey"),
                  )?.[1] ?? draft.auth
                }`}
              >
                <EditorChoice
                  name="omp-auth"
                  label="认证方式"
                  help="本地免认证服务选“免认证”；已在 oh-my-pi 里登录的服务选“已有 OAuth 授权”，这两种都不需要填写密钥。"
                  value={draft.auth || "apiKey"}
                  options={AUTH_OPTIONS}
                  onChange={(value) => field("auth", value)}
                />
              </EditorAdvanced>
              {connection.kind === "error" && (
                <p className="editor-feedback" role="alert">
                  {connection.message}
                </p>
              )}
            </fieldset>
            <EditorSaveSummary
              rows={[
                ["线路", draft.id.trim() || "未命名线路"],
                [
                  "地址",
                  draft.baseUrl.trim()
                    ? previewOrigin(draft.baseUrl.trim())
                    : "继承内置端点",
                ],
                ["模型", draftModelsSummary(draft.models)],
                [
                  "协议",
                  draft.api.trim()
                    ? (apiLabels[draft.api.trim()] ?? draft.api.trim())
                    : "沿用模型自身的协议",
                ],
                ["写入", `${TOOL_NAME} 的 models.yml`],
              ]}
            >
              <p>
                {draft.original === null
                  ? `保存后立即写入 ${TOOL_NAME} 的 models.yml；${TOOL_NAME} 会加载其中所有线路，重新加载后即可选择模型。`
                  : `这是正在使用的线路，保存后立即写入 ${TOOL_NAME} 的 models.yml。`}
              </p>
              <p>仅写入当前 OMP profile，不影响 Pi，也不自动切换默认模型。</p>
              <p className="break-all">配置位置：{document?.path}</p>
              <p>
                未编辑字段会保留；保存会规范化 YAML 排版并移除注释。不读取 auth
                文件，不执行密钥命令。
              </p>
            </EditorSaveSummary>
          </form>
        </FullScreenPanel>
      ) : (
        document &&
        (Object.keys(providers).length ? (
          <>
            <div className="tool-lines-caption">
              <span>{Object.keys(providers).length} 条线路</span>
              <span className="tool-lines-source">来自 OMP 配置文件</span>
            </div>
            {/* Same list as the other tool pages. OMP loads every line in
                models.yml, so there is no per-line on/off state to show. */}
            <div
              className="tool-lines"
              data-variant="omp"
              role="table"
              aria-label="OMP 自定义线路"
            >
              <div className="tool-line-row tool-line-head" role="row">
                <span role="columnheader">线路</span>
                <span role="columnheader">请求地址</span>
                <span role="columnheader">协议</span>
                <span role="columnheader">模型</span>
                <span role="columnheader" className="tool-line-actions">
                  操作
                </span>
              </div>
              {Object.entries(providers).map(([id, raw]) => {
                const provider = object(raw);
                const baseUrl = text(provider.baseUrl);
                const api = text(provider.api);
                const models = (
                  Array.isArray(provider.models) ? provider.models : []
                )
                  .map((model) => text(object(model).id))
                  .filter(Boolean);
                return (
                  <div key={id} className="tool-line-row" role="row">
                    <span role="rowheader" className="tool-line-name">
                      <LineBadge line={{ id, name: id }} />
                      <span title={id}>{id}</span>
                    </span>
                    {baseUrl ? (
                      <span
                        role="cell"
                        className="tool-line-mono"
                        title={baseUrl}
                      >
                        {baseUrl}
                      </span>
                    ) : (
                      <span role="cell" className="tool-line-muted">
                        继承内置端点
                      </span>
                    )}
                    {api ? (
                      <span role="cell" className="tool-line-text" title={api}>
                        {apiShortLabels[api] ?? api}
                      </span>
                    ) : (
                      <span role="cell" className="tool-line-muted">
                        继承模型协议
                      </span>
                    )}
                    {models.length ? (
                      <span
                        role="cell"
                        className="tool-line-models"
                        title={models.join("\n")}
                      >
                        <span className="tool-line-mono">{models[0]}</span>
                        {models.length > 1 && (
                          <>
                            <span
                              className="tool-line-count"
                              aria-hidden="true"
                            >
                              +{models.length - 1}
                            </span>
                            <span className="sr-only">
                              ，另有 {models.length - 1} 个模型
                            </span>
                          </>
                        )}
                      </span>
                    ) : (
                      <span role="cell" className="tool-line-muted">
                        内置模型覆盖
                      </span>
                    )}
                    <span role="cell" className="tool-line-actions">
                      <button
                        type="button"
                        className="tool-line-icon"
                        aria-label={`编辑${id}`}
                        title="编辑线路"
                        disabled={busy || !native}
                        onClick={() => edit(id)}
                      >
                        <Pencil size={15} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="tool-provider-delete"
                        aria-label={`删除${id}`}
                        title="删除线路"
                        disabled={busy || !native}
                        onClick={() => setPending({ delete: id })}
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="tool-empty">
            <h3>尚未配置自定义线路</h3>
            <p>
              添加 API 地址和模型即可接入。OMP
              内置服务商及已有登录不会在这里列出。
            </p>
            <button
              type="button"
              className="tool-btn is-primary"
              disabled={!native || busy}
              onClick={() => edit(null)}
            >
              <Plus size={15} aria-hidden="true" />
              添加第一条线路
            </button>
          </div>
        ))
      )}
      {document && (
        <details className="tool-installation chimera-disclosure">
          <summary>配置位置与保存说明</summary>
          <div className="chimera-disclosure-body">
            <p className="tool-install-path">{document.path}</p>
            <p className="tool-install-note">
              跟随应用进程环境中的 OMP profile，仅管理该配置，不扫描其他
              profile。保存保留未编辑字段，但会规范化 YAML
              排版并移除注释。不读取 auth
              文件、不执行密钥命令，也不会自动切换默认模型。
            </p>
          </div>
        </details>
      )}
      <ConfirmDialog
        isOpen={pending !== null}
        busy={busy}
        title={
          pending === "save"
            ? "保存 OMP 线路？"
            : pending === "restore"
              ? "恢复默认模板？"
              : typeof pending === "object" && pending
                ? "删除 OMP 线路？"
                : "放弃当前草稿？"
        }
        message={
          pending === "save"
            ? "将写入 OMP 原生模型配置。未编辑字段会保留；YAML 注释和排版不会保留。"
            : pending === "restore"
              ? "这会重新填写地址和协议，并清空密钥、认证方式和已选模型；线路 ID 保持不变。"
              : typeof pending === "object" && pending
                ? `将从 OMP 模型配置移除 ${pending.delete}，该线路的自定义模型将不可用。`
                : "尚未保存的线路编辑将被丢弃。"
        }
        variant={pending === "save" ? "info" : "destructive"}
        confirmText={
          pending === "save"
            ? "确认保存"
            : pending === "restore"
              ? "恢复模板"
              : typeof pending === "object" && pending
                ? "确认删除"
                : "放弃草稿"
        }
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending === "save") void save();
          else if (pending === "restore") {
            setPending(null);
            setDirty(true);
            setDraft(
              (current) =>
                current && {
                  ...current,
                  baseUrl: getChimeraHubTemplate().baseUrl,
                  api: "openai-completions",
                  apiKey: "",
                  auth: "",
                  models: "",
                },
            );
          } else if (typeof pending === "object" && pending)
            void save(pending.delete);
          else {
            const reload = pending === "reload";
            setPending(null);
            if (reload) void load();
            else setDraft(null);
          }
        }}
      />
      <ConfirmDialog
        isOpen={lossyRetry !== null}
        busy={busy}
        title="models.yml 含注释或锚点"
        message="OMP 配置文件里有注释、锚点或别名。保存会重写整个文件：注释会丢失，锚点和别名会展开成重复内容。保存前会把原文件备份到同一目录（原文件名后加 .bak-时间）。"
        variant="destructive"
        confirmText="备份后保存"
        onCancel={() => setLossyRetry(null)}
        onConfirm={() => void save(lossyRetry?.deleteId, true)}
      />
    </section>
  );
}
