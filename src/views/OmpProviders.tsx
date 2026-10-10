import { createPortal } from "react-dom";
import {
  ChevronLeft,
  Eye,
  EyeOff,
  RefreshCw,
  Plus,
  Edit2,
  Trash2,
} from "lucide-react";
import { OmpModelPicker } from "./OmpModelPicker";
import { getChimeraHubTemplate } from "@/config/codexTemplates";
import { useContext, useEffect, useRef, useState } from "react";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import { ToolPageActiveContext } from "@/components/RetainedToolPage";
import { Button } from "@/components/ui/button";
import "@/components/ProviderEditorPage.css";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";
import { ompApi, ompApis } from "@/lib/api/omp";
import type { PiDocument } from "@/lib/api/pi";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
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
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<
    "save" | "discard" | "reload" | { delete: string } | null
  >(null);
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
  const save = async (deleteId?: string) => {
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
      setDocument(await ompApi.save(value, document));
      setDraft(null);
      setPending(null);
      setNotice(
        deleteId !== undefined
          ? "线路已删除。"
          : "线路已保存。请在 OMP 中重新加载并选择模型。",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPending(null);
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
  const actions = (
    <>
      <button
        type="button"
        className="h-[32px] px-[10px] flex items-center gap-[6px] rounded-[4px] border border-[var(--border-control)] bg-transparent cursor-pointer disabled:opacity-50"
        disabled={!native || busy}
        onClick={() => (draft ? setPending("reload") : void load())}
      >
        <RefreshCw size={15} className={busy ? "animate-spin" : ""} />
        刷新线路
      </button>
      {!draft && (
        <button
          type="button"
          className="h-[32px] px-[12px] flex items-center gap-[6px] rounded-[4px] border-0 bg-[#006AA0] text-white cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={!native || busy || !document}
          onClick={() => edit(null)}
        >
          <Plus size={16} />
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
        <p className="text-sm text-[var(--text-3)]">
          请在桌面应用中管理本地线路。
        </p>
      )}
      {busy && <p role="status">正在处理线路配置…</p>}
      {error && !draft && (
        <p
          role="alert"
          className="text-sm text-destructive whitespace-pre-wrap"
        >
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
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
                <h2>{draft.id.trim() || "新线路"}</h2>
                <span>
                  Oh My Pi · {draft.original === null ? "新建线路" : "编辑线路"}
                </span>
              </div>
              <span className="editor-draft-status" role="status">
                {busy ? "正在保存…" : dirty ? "未保存修改" : ""}
              </span>
            </>
          }
          footer={
            <>
              <span className="editor-test-scope">
                保存后请在 OMP 中重新加载并选择模型。
              </span>
              <div className="editor-save-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={requestClose}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="primary"
                  form="omp-provider-form"
                  disabled={busy}
                >
                  {busy ? "正在保存…" : "保存线路"}
                </button>
              </div>
            </>
          }
        >
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
              <section
                className="editor-basic"
                aria-labelledby="omp-basic-title"
              >
                <h3 id="omp-basic-title">基础</h3>
                <div className="editor-basic-grid">
                  <label>
                    线路 ID *
                    <input
                      aria-label="线路 ID"
                      value={draft.id}
                      disabled={draft.original !== null}
                      placeholder="例如 chimera"
                      onChange={(e) => field("id", e.target.value)}
                    />
                    <small>
                      OMP 配置中的唯一标识；保存后不可修改，不是显示名称。
                    </small>
                  </label>
                  <label>
                    API 请求地址{draft.models.trim() ? " *" : ""}
                    <input
                      aria-label="API 地址"
                      value={draft.baseUrl}
                      placeholder="https://api.example.com/v1"
                      onChange={(e) => field("baseUrl", e.target.value)}
                    />
                    <small>
                      填写服务商的完整基础地址；配置自定义模型时必填。
                    </small>
                  </label>
                  <label>
                    API Key / 环境变量名
                    <div className="password-field">
                      <input
                        aria-label="API Key / 环境变量名"
                        type={showKey ? "text" : "password"}
                        autoComplete="new-password"
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
                    <small>
                      可填写密钥或已在 oh-my-pi
                      运行环境设置的变量名；本页不会创建环境变量。
                    </small>
                  </label>
                </div>
              </section>
              <section
                className="editor-protocol"
                aria-labelledby="omp-protocol-title"
              >
                <h3 id="omp-protocol-title">协议与模型</h3>
                <label>
                  API 协议
                  <select
                    aria-label="API 协议"
                    value={draft.api}
                    onChange={(e) => field("api", e.target.value)}
                  >
                    {!ompApis.includes(draft.api) && (
                      <option value={draft.api}>
                        {draft.api || "请选择接口类型"}
                      </option>
                    )}
                    {ompApis.map((api) => (
                      <option key={api} value={api}>
                        {(
                          {
                            "openai-completions": "Chat Completions",
                            "openai-responses": "Responses",
                            "anthropic-messages": "Anthropic Messages",
                            "google-generative-ai": "Gemini",
                          } as Record<string, string>
                        )[api] ?? api}
                      </option>
                    ))}
                  </select>
                  <small>
                    自定义模型需指定协议，或保留模型自身已有的协议配置。
                  </small>
                </label>
                <label>
                  认证方式
                  <select
                    aria-label="认证方式"
                    value={draft.auth || "apiKey"}
                    onChange={(e) => field("auth", e.target.value)}
                  >
                    <option value="apiKey">API Key / 环境变量</option>
                    <option value="none">免认证（本地服务）</option>
                    <option value="oauth">已有 OAuth 授权</option>
                  </select>
                </label>
                <OmpModelPicker
                  baseUrl={draft.baseUrl}
                  apiKey={draft.apiKey}
                  api={draft.api}
                  auth={draft.auth}
                  value={draft.models}
                  onChange={(value) => field("models", value)}
                />
                <label>
                  已选模型（可手动补充，每行一个）
                  <textarea
                    aria-label="模型 ID"
                    rows={3}
                    value={draft.models}
                    placeholder="model-id"
                    onChange={(e) => field("models", e.target.value)}
                  />
                  <small>
                    同 ID 模型的高级参数会保留；移除 ID
                    将移除该模型配置。覆盖内置服务商时可以留空。
                  </small>
                </label>
              </section>
              <details className="editor-preview">
                <summary>保存详情</summary>
                <p className="editor-test-scope">
                  配置模板：ChimeraHub。仅写入当前 OMP profile，不影响
                  Pi，不自动切换默认模型。
                </p>
                <p className="editor-test-scope break-all">
                  配置位置：{document?.path}
                </p>
                <p className="editor-test-scope">
                  未编辑字段会保留；保存会规范化 YAML 排版并移除注释。不读取
                  auth 文件，不执行密钥命令。
                </p>
              </details>
            </fieldset>
          </form>
        </FullScreenPanel>
      ) : (
        document &&
        (Object.keys(providers).length ? (
          <div className="omp-provider-table">
            <table aria-label="OMP 自定义线路">
              <thead>
                <tr>
                  <th scope="col">名称</th>
                  <th scope="col">端点地址</th>
                  <th scope="col">协议 / 模型</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(providers).map(([id, raw]) => {
                  const provider = object(raw);
                  const models = Array.isArray(provider.models)
                    ? provider.models
                    : [];
                  return (
                    <tr key={id}>
                      <th scope="row">
                        <span className="omp-provider-name">
                          <span
                            className="omp-provider-icon"
                            aria-hidden="true"
                          >
                            {id.slice(0, 1)}
                          </span>
                          <span>{id}</span>
                        </span>
                      </th>
                      <td className="omp-provider-endpoint">
                        {text(provider.baseUrl) || "继承内置端点"}
                      </td>
                      <td>
                        <span>{text(provider.api) || "继承模型协议"}</span>
                        <small>
                          {models.length
                            ? `${models.length} 个自定义模型`
                            : "内置模型覆盖"}
                        </small>
                      </td>
                      <td>
                        <div className="omp-provider-actions">
                          <button
                            type="button"
                            title={`编辑 ${id}`}
                            aria-label="编辑"
                            className="omp-provider-edit"
                            disabled={busy || !native}
                            onClick={() => edit(id)}
                          >
                            <Edit2 size={14} />
                          </button>
                          <button
                            type="button"
                            title={`删除 ${id}`}
                            className="tool-provider-delete"
                            disabled={busy || !native}
                            onClick={() => setPending({ delete: id })}
                          >
                            <Trash2 size={13} />
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed p-8 text-center">
            <h3 className="font-medium">尚未配置自定义线路</h3>
            <p className="mt-2 text-sm text-[var(--text-3)]">
              添加 API 地址和模型即可接入。OMP
              内置服务商及已有登录不会在这里列出。
            </p>
            <Button
              className="mt-4"
              disabled={!native || busy}
              onClick={() => edit(null)}
            >
              添加第一条线路
            </Button>
          </div>
        ))
      )}
      {document && (
        <details className="tool-installation text-[var(--text-3)]">
          <summary className="cursor-pointer">配置位置与保存说明</summary>
          <p className="mt-2 break-all">{document.path}</p>
          <p className="mt-2">
            跟随应用进程环境中的 OMP profile，仅管理该配置，不扫描其他
            profile。保存保留未编辑字段，但会规范化 YAML 排版并移除注释。不读取
            auth 文件、不执行密钥命令，也不会自动切换默认模型。
          </p>
        </details>
      )}
      <ConfirmDialog
        isOpen={pending !== null}
        busy={busy}
        title={
          pending === "save"
            ? "保存 OMP 线路？"
            : typeof pending === "object" && pending
              ? "删除 OMP 线路？"
              : "放弃当前草稿？"
        }
        message={
          pending === "save"
            ? "将写入 OMP 原生模型配置。未编辑字段会保留；YAML 注释和排版不会保留。"
            : typeof pending === "object" && pending
              ? `将从 OMP 模型配置移除 ${pending.delete}，该线路的自定义模型将不可用。`
              : "尚未保存的线路编辑将被丢弃。"
        }
        variant={pending === "save" ? "info" : "destructive"}
        confirmText={
          pending === "save"
            ? "确认保存"
            : typeof pending === "object" && pending
              ? "确认删除"
              : "放弃草稿"
        }
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending === "save") void save();
          else if (typeof pending === "object" && pending)
            void save(pending.delete);
          else {
            const reload = pending === "reload";
            setPending(null);
            if (reload) void load();
            else setDraft(null);
          }
        }}
      />
    </section>
  );
}
