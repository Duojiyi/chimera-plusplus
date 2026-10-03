import { useRef, useState } from "react";
import { CcSwitchImportPreview } from "./CcSwitchImportPreview";
import { deeplinkApi } from "@/lib/api/deeplink";
import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";

export function ImportPanel({
  native,
  onImported,
}: {
  native: boolean;
  onImported?: () => void;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  useLightweightCloseBlocker(busy);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!native || inFlight.current || !url.trim()) return;
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    setFailed(false);
    try {
      await deeplinkApi.submitImport(url.trim());
      setUrl("");
      setMessage("已加入待确认队列，请在确认窗口核对内容；此操作尚未导入。");
    } catch {
      setFailed(true);
      setMessage(
        "无法提交导入链接，请检查链接格式、目标工具是否已开放，或处理已有的待确认请求后重试。",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="settings-import-heading">
      <h2 id="settings-import-heading">导入</h2>
      <p className="settings-tools-description">
        通过导入链接添加资源。先查看内容与写入范围，再确认导入；不会因粘贴链接直接启用。
      </p>
      <form className="settings-import-form" onSubmit={submit}>
        <label htmlFor="settings-import-url">导入链接</label>
        <input
          id="settings-import-url"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          disabled={busy || !native}
          placeholder="chimera://v1/import?… 或 ccswitch://v1/import?…"
        />
        <p className="settings-tools-description">
          链接可能包含密钥，仅在本机处理。ccswitch://
          仅支持供应商；其他资源请使用 chimera://。
        </p>
        <button
          type="submit"
          className="secondary"
          disabled={!native || busy || !url.trim()}
        >
          {busy ? "正在提交…" : "预览并确认"}
        </button>
      </form>
      {!native && (
        <p className="settings-tools-preview-note" role="status">
          浏览器预览无法调用本机导入服务，请在桌面应用中操作。
        </p>
      )}
      {message && <p role={failed ? "alert" : "status"}>{message}</p>}
      <CcSwitchImportPreview native={native} onImported={onImported} />
    </section>
  );
}
