import { useEffect, useRef, useState } from "react";
import { fetchModelsForConfig } from "@/lib/api/model-fetch";

export function OmpModelPicker({
  baseUrl,
  apiKey,
  api,
  auth,
  value,
  onChange,
}: {
  baseUrl: string;
  apiKey: string;
  api: string;
  auth: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [temporaryKey, setTemporaryKey] = useState("");
  const sequence = useRef(0);
  // Never send a variable name or execute an OMP credential command as a key.
  const needsTemporaryKey =
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKey.trim()) ||
    apiKey.trim().startsWith("!") ||
    ["none", "oauth"].includes(auth);
  useEffect(() => {
    sequence.current++;
    setModels([]);
    setMessage("");
    setQuery("");
    setLoading(false);
    setTemporaryKey("");
    return () => {
      sequence.current++;
    };
  }, [baseUrl, apiKey, api, auth]);
  const fetch = async () => {
    const key = needsTemporaryKey ? temporaryKey.trim() : apiKey.trim();
    if (!key) {
      setMessage(
        needsTemporaryKey
          ? "请填写用于本次获取的 API Key，或手动填写模型。"
          : "请先填写线路的 API Key。",
      );
      return;
    }
    try {
      const url = new URL(baseUrl.trim());
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error();
    } catch {
      setMessage("请先填写有效的 HTTP(S) API 请求地址。");
      return;
    }
    const current = ++sequence.current;
    setLoading(true);
    setMessage("");
    setModels([]);
    try {
      const result = await fetchModelsForConfig(baseUrl.trim(), key);
      if (current !== sequence.current) return;
      const ids = [
        ...new Set(result.map((model) => model.id.trim()).filter(Boolean)),
      ];
      setModels(ids);
      setMessage(
        ids.length
          ? `已获取 ${ids.length} 个模型，勾选后自动填入，不会自动保存。`
          : "服务商未返回模型，可手动填写模型 ID。",
      );
    } catch {
      if (current === sequence.current)
        setMessage(
          "获取失败，请检查地址、密钥和服务商是否支持 /models；也可手动填写模型 ID。",
        );
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  };
  const selected = value
    .split("\n")
    .map((id) => id.trim())
    .filter(Boolean);
  const filtered = models.filter((id) =>
    id.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="omp-model-picker">
      <div className="editor-format-line">
        <b>可用模型</b>
        <button
          type="button"
          className="secondary"
          disabled={loading || !baseUrl.trim()}
          onClick={() => void fetch()}
        >
          {loading
            ? "正在获取…"
            : models.length
              ? "重新获取模型"
              : "获取模型列表"}
        </button>
      </div>
      <p className="editor-test-scope">
        从当前地址的 OpenAI 兼容模型接口获取，勾选后自动填入下方列表。
      </p>
      {needsTemporaryKey && (
        <label className="omp-discovery-key">
          用于获取模型的 API Key
          <input
            type="password"
            autoComplete="new-password"
            value={temporaryKey}
            onChange={(e) => {
              sequence.current++;
              setLoading(false);
              setModels([]);
              setMessage("");
              setTemporaryKey(e.target.value);
            }}
            placeholder="仅用于本次获取，不写入线路配置"
          />
          <small>
            不读取环境变量或 OAuth 凭证，不执行密钥命令；原认证配置保持不变。
          </small>
        </label>
      )}
      {message && (
        <p className="editor-test-scope" role="status">
          {message}
        </p>
      )}
      {!!models.length && (
        <>
          <input
            aria-label="搜索可用模型"
            placeholder="搜索模型 ID"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="omp-model-options" role="group" aria-label="可用模型">
            {filtered.map((id) => (
              <label key={id}>
                <input
                  type="checkbox"
                  checked={selected.includes(id)}
                  onChange={(e) =>
                    onChange(
                      (e.target.checked
                        ? [...new Set([...selected, id])]
                        : selected.filter((item) => item !== id)
                      ).join("\n"),
                    )
                  }
                />
                <span>{id}</span>
              </label>
            ))}
            {!filtered.length && (
              <p className="editor-test-scope">没有匹配的模型。</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
