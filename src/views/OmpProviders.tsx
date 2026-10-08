import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

export function OmpProviders({ native }: { native: boolean }) {
  const [document, setDocument] = useState<PiDocument | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
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
      setError(String(e));
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
    setDraft({
      original: id,
      id: id ?? "",
      baseUrl: text(provider.baseUrl),
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
      setError(String(e));
      setPending(null);
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const field = (key: keyof Draft, value: string) =>
    setDraft((current) => (current ? { ...current, [key]: value } : null));
  return (
    <section className="space-y-4" aria-label="OMP 模型线路">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">模型线路</h2>
          <p className="text-sm text-[var(--text-3)]">
            管理 OMP 自定义服务商与模型，不影响 Pi。
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!native || busy}
            onClick={() => (draft ? setPending("reload") : void load())}
          >
            刷新线路
          </Button>
          <Button
            disabled={!native || busy || !document || !!draft}
            onClick={() => edit(null)}
          >
            添加线路
          </Button>
        </div>
      </div>
      {!native && (
        <p className="text-sm text-[var(--text-3)]">
          请在桌面应用中管理本地线路。
        </p>
      )}
      {busy && <p role="status">正在处理线路配置…</p>}
      {error && (
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
        <form
          aria-label="编辑 OMP 线路"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              build();
              setError("");
              setPending("save");
            } catch (e) {
              setError(String(e));
            }
          }}
          className="rounded-xl border p-5 space-y-4"
        >
          <h3 className="font-semibold">
            {draft.original === null ? "添加线路" : `编辑 ${draft.original}`}
          </h3>
          <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              线路 ID
              <Input
                aria-label="线路 ID"
                value={draft.id}
                disabled={draft.original !== null}
                placeholder="my-provider"
                onChange={(e) => field("id", e.target.value)}
              />
            </label>
            <label className="space-y-1 text-sm">
              API 协议
              <Input
                aria-label="API 协议"
                list="omp-api-options"
                value={draft.api}
                placeholder="openai-completions"
                onChange={(e) => field("api", e.target.value)}
              />
              <datalist id="omp-api-options">
                {ompApis.map((api) => (
                  <option key={api} value={api} />
                ))}
              </datalist>
            </label>
            <label className="space-y-1 text-sm sm:col-span-2">
              API 地址
              <Input
                aria-label="API 地址"
                value={draft.baseUrl}
                placeholder="https://api.example.com/v1"
                onChange={(e) => field("baseUrl", e.target.value)}
              />
            </label>
            <label className="space-y-1 text-sm">
              认证方式
              <select
                aria-label="认证方式"
                className="w-full h-9 rounded-md border bg-[var(--bg-surface)] px-3"
                value={draft.auth}
                onChange={(e) => field("auth", e.target.value)}
              >
                <option value="">默认（API Key）</option>
                <option value="apiKey">API Key</option>
                <option value="none">免认证（本地服务）</option>
                <option value="oauth">已有 OAuth 授权</option>
              </select>
            </label>
            <label className="space-y-1 text-sm">
              API Key / 环境变量名
              <Input
                aria-label="API Key / 环境变量名"
                type="password"
                autoComplete="new-password"
                value={draft.apiKey}
                placeholder="推荐填写环境变量名"
                onChange={(e) => field("apiKey", e.target.value)}
              />
            </label>
            <label className="space-y-1 text-sm sm:col-span-2">
              模型 ID（每行一个）
              <textarea
                aria-label="模型 ID"
                className="w-full min-h-28 rounded-md border bg-transparent p-3 font-mono text-sm"
                value={draft.models}
                placeholder="model-id"
                onChange={(e) => field("models", e.target.value)}
              />
              <span className="block text-xs text-[var(--text-3)]">
                同 ID 模型的高级参数会保留；移除 ID
                将移除该模型配置。覆盖内置服务商时可以留空。
              </span>
            </label>
          </fieldset>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setPending("discard")}
            >
              取消编辑
            </Button>
            <Button type="submit" disabled={busy}>
              保存线路
            </Button>
          </div>
        </form>
      ) : (
        document &&
        (Object.keys(providers).length ? (
          <div className="divide-y rounded-xl border">
            {Object.entries(providers).map(([id, raw]) => {
              const provider = object(raw);
              const models = Array.isArray(provider.models)
                ? provider.models
                : [];
              return (
                <article
                  key={id}
                  className="flex flex-wrap items-center justify-between gap-3 p-4"
                >
                  <div className="min-w-0 flex-1">
                    <h3 className="font-semibold break-all">{id}</h3>
                    <p className="mt-1 text-sm text-[var(--text-3)]">
                      {text(provider.api) || "继承模型协议"} ·{" "}
                      {models.length
                        ? `${models.length} 个自定义模型`
                        : "内置模型覆盖"}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || !native}
                      onClick={() => edit(id)}
                    >
                      编辑
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy || !native}
                      onClick={() => setPending({ delete: id })}
                    >
                      删除
                    </Button>
                  </div>
                </article>
              );
            })}
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
        <details className="text-xs text-[var(--text-3)]">
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
