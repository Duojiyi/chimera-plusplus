import { useState } from "react";
import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { piApi, type PiDocument, type PiDocumentKind } from "@/lib/api/pi";

const kinds: PiDocumentKind[] = ["settings", "mcp"];
const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const text = (value: unknown) => (typeof value === "string" ? value : "");

export function PiManagement({ native }: { native: boolean }) {
  const [documents, setDocuments] = useState<
    Partial<Record<PiDocumentKind, PiDocument>>
  >({});
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState("");
  const [mcp, setMcp] = useState("");
  const [loading, setLoading] = useState({ settings: false, mcp: false });
  const [pending, setPending] = useState<PiDocumentKind | null>(null);
  const [errors, setErrors] = useState({ settings: "", mcp: "" });
  const busy = loading.settings || loading.mcp;
  const dirtyDocuments = {
    settings:
      !!documents.settings &&
      (provider !== text(documents.settings.value.defaultProvider) ||
        model !== text(documents.settings.value.defaultModel) ||
        thinking !== text(documents.settings.value.defaultThinkingLevel)),
    mcp:
      !!documents.mcp && mcp !== JSON.stringify(documents.mcp.value, null, 2),
  };
  const dirty = dirtyDocuments.settings || dirtyDocuments.mcp;
  useLightweightCloseBlocker(dirty || busy);
  const [discard, setDiscard] = useState<PiDocumentKind[] | null>(null);
  const load = async (kind: PiDocumentKind) => {
    if (!native || loading[kind]) return;
    setLoading((current) => ({ ...current, [kind]: true }));
    setErrors((current) => ({ ...current, [kind]: "" }));
    try {
      const document = await piApi.read(kind);
      setDocuments((current) => ({ ...current, [kind]: document }));
      if (kind === "settings") {
        setProvider(text(document.value.defaultProvider));
        setModel(text(document.value.defaultModel));
        setThinking(text(document.value.defaultThinkingLevel));
      } else {
        setMcp(JSON.stringify(document.value, null, 2));
      }
    } catch (e) {
      setErrors((current) => ({ ...current, [kind]: String(e) }));
    } finally {
      setLoading((current) => ({ ...current, [kind]: false }));
    }
  };
  const requestLoad = (targets: PiDocumentKind[]) => {
    if (targets.some((kind) => dirtyDocuments[kind])) setDiscard(targets);
    else targets.forEach((kind) => void load(kind));
  };
  const save = async () => {
    if (!native || !pending || !documents[pending] || loading[pending]) return;
    const kind = pending;
    const document = documents[kind]!;
    setLoading((current) => ({ ...current, [kind]: true }));
    setErrors((current) => ({ ...current, [kind]: "" }));
    try {
      let value: Record<string, unknown>;
      if (kind === "settings") {
        value = { ...document.value };
        for (const [key, content] of [
          ["defaultProvider", provider],
          ["defaultModel", model],
          ["defaultThinkingLevel", thinking],
        ]) {
          if (content.trim()) value[key] = content.trim();
          else delete value[key];
        }
      } else {
        const parsed: unknown = JSON.parse(mcp);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("MCP 配置必须是 JSON 对象");
        value = parsed as Record<string, unknown>;
        if (
          "mcpServers" in value &&
          (!value.mcpServers ||
            typeof value.mcpServers !== "object" ||
            Array.isArray(value.mcpServers))
        )
          throw new Error("mcpServers 必须是对象");
      }
      const saved = await piApi.save(kind, value, document.revision);
      // Refresh only the saved editor; the other draft remains untouched.
      if (kind === "settings") {
        setProvider(text(saved.value.defaultProvider));
        setModel(text(saved.value.defaultModel));
        setThinking(text(saved.value.defaultThinkingLevel));
      } else {
        setMcp(JSON.stringify(saved.value, null, 2));
      }
      setDocuments((current) => ({ ...current, [kind]: saved }));
      setPending(null);
      toast.success(
        kind === "settings"
          ? "默认设置已保存，下次启动 Pi 生效"
          : "MCP 已保存，请在 Pi 中执行 /reload",
      );
    } catch (e) {
      setErrors((current) => ({ ...current, [kind]: String(e) }));
      setPending(null);
    } finally {
      setLoading((current) => ({ ...current, [kind]: false }));
    }
  };
  return (
    <section className="tool-support-panel" aria-label="Pi 模型与 MCP">
      <div className="space-y-4 p-4 text-sm">
        <p>
          管理全局配置，项目配置可能覆盖这里的设置。兼容 Pi 1.1；不会读取
          auth.json、启动 MCP 或执行扩展。保存会规范化为
          JSON，不保留原文件注释。
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!native || busy}
            onClick={() => requestLoad(kinds)}
          >
            {busy
              ? "处理中…"
              : kinds.some((kind) => documents[kind] || errors[kind])
                ? "重新读取"
                : "读取全局配置"}
          </Button>
        </div>
        {!native && <p>配置读写仅在桌面应用中可用。</p>}
        <p className="text-muted-foreground">
          切换页面会保留草稿；重新读取有未保存修改的配置前会询问是否放弃草稿。
        </p>
        {kinds.map((kind) => (
          <div key={kind}>
            {loading[kind] && (
              <p role="status">
                正在处理 {kind === "settings" ? "默认设置" : "MCP"}…
              </p>
            )}
            {errors[kind] && (
              <>
                <p role="alert" className="text-destructive break-all">
                  {kind === "settings" ? "默认设置" : "MCP"}：{errors[kind]}
                  。如有外部修改，请保留草稿后重新读取最新配置。
                </p>
                <Button
                  variant="outline"
                  disabled={!native || loading[kind]}
                  onClick={() => requestLoad([kind])}
                >
                  {kind === "settings" ? "重试读取默认设置" : "重试读取 MCP"}
                </Button>
              </>
            )}
          </div>
        ))}
        {documents.settings && (
          <section className="space-y-3" aria-label="Pi 默认模型">
            <h3 className="font-semibold">启动默认值</h3>
            <p className="text-muted-foreground break-all">
              {documents.settings.path}
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <label>
                供应商 ID
                <Input
                  value={provider}
                  disabled={!native || loading.settings}
                  onChange={(e) => {
                    setProvider(e.target.value);
                  }}
                  placeholder="留空由 Pi 自动选择"
                />
              </label>
              <label>
                模型 ID
                <Input
                  value={model}
                  disabled={!native || loading.settings}
                  onChange={(e) => {
                    setModel(e.target.value);
                  }}
                  placeholder="支持内置和自定义模型"
                />
              </label>
              <label>
                思考级别
                <select
                  className="block h-10 w-full rounded border bg-background px-2"
                  value={thinking}
                  disabled={!native || loading.settings}
                  onChange={(e) => {
                    setThinking(e.target.value);
                  }}
                >
                  <option value="">Pi 默认</option>
                  {levels.map((level) => (
                    <option key={level}>{level}</option>
                  ))}
                </select>
              </label>
            </div>
            <Button
              disabled={!native || loading.settings}
              onClick={() => setPending("settings")}
            >
              保存默认设置
            </Button>
          </section>
        )}
        {documents.mcp && (
          <section className="space-y-3" aria-label="Pi MCP 配置">
            <h3 className="font-semibold">原生 MCP</h3>
            <p className="text-muted-foreground break-all">
              {documents.mcp.path}
            </p>
            <p>
              支持 mcpServers 中的 stdio 和 HTTP 服务。保存后由 Pi
              加载；请先审查命令、环境变量和服务地址。
            </p>
            <textarea
              aria-label="Pi MCP JSON"
              className="min-h-40 w-full rounded border bg-background p-3 font-mono text-xs"
              value={mcp}
              disabled={!native || loading.mcp}
              onChange={(e) => {
                setMcp(e.target.value);
              }}
              spellCheck={false}
            />
            <Button
              disabled={!native || loading.mcp}
              onClick={() => setPending("mcp")}
            >
              保存 MCP
            </Button>
          </section>
        )}
      </div>
      <ConfirmDialog
        isOpen={discard !== null}
        busy={discard?.some((kind) => loading[kind]) ?? false}
        title="放弃未保存草稿？"
        message="重新读取会用磁盘上的最新配置替换当前草稿。"
        confirmText="放弃并重新读取"
        onCancel={() => setDiscard(null)}
        onConfirm={() => {
          discard?.forEach((kind) => void load(kind));
          setDiscard(null);
        }}
      />
      <ConfirmDialog
        isOpen={pending !== null}
        busy={pending !== null && loading[pending]}
        title={
          pending === "mcp" ? "保存 Pi MCP 配置？" : "保存 Pi 启动默认值？"
        }
        message={
          pending === "mcp"
            ? "将写入全局 mcp.json，Pi 在重新加载时可能启动配置的外部程序或连接服务。确认你信任这些配置。"
            : "将更新全局 settings.json 的默认模型设置，保留其他字段。下次启动 Pi 生效，项目设置仍可覆盖。"
        }
        variant="info"
        confirmText="确认保存"
        onConfirm={() => void save()}
        onCancel={() => {
          if (!pending || !loading[pending]) setPending(null);
        }}
      />
    </section>
  );
}
