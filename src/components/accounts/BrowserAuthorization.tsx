import { useEffect, useId, useRef, useState } from "react";
import { Copy, ExternalLink, Loader2, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { settingsApi } from "@/lib/api/settings";
import "./BrowserAuthorization.css";

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function AuthorizationLink({ url }: { url: string }) {
  const fieldId = useId();
  const [error, setError] = useState<string | null>(null);
  const run = async (action: "copy" | "open") => {
    setError(null);
    try {
      if (action === "copy") {
        await copyText(url);
        toast.success("授权链接已复制");
      } else {
        await settingsApi.openExternal(url);
      }
    } catch (cause) {
      setError(
        (action === "copy" ? "复制失败：" : "无法打开浏览器：") +
          message(cause),
      );
    }
  };
  return (
    <div className="browser-auth-link">
      <label htmlFor={fieldId}>授权链接</label>
      <input
        id={fieldId}
        value={url}
        readOnly
        spellCheck={false}
        onFocus={(event) => event.currentTarget.select()}
      />
      <div className="browser-auth-link-actions">
        <Button variant="outline" size="sm" onClick={() => void run("copy")}>
          <Copy size={14} aria-hidden="true" />
          复制授权链接
        </Button>
        <Button variant="outline" size="sm" onClick={() => void run("open")}>
          <ExternalLink size={14} aria-hidden="true" />
          重新打开浏览器
        </Button>
      </div>
      {error && (
        <p className="browser-auth-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Unmount on completion/cancellation, and key by flow id to isolate attempts. */
export function ManualAuthorization({
  mode,
  onSubmit,
}: {
  mode: "claude" | "codex";
  onSubmit: (input: string) => Promise<void>;
}) {
  const fieldId = useId();
  const helpId = useId();
  const errorId = useId();
  const [value, setValue] = useState("");
  const [phase, setPhase] = useState<"idle" | "submitting" | "submitted">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const submitting = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const submit = async () => {
    if (submitting.current || !value.trim()) return;
    submitting.current = true;
    setError(null);
    setPhase("submitting");
    try {
      await onSubmit(value.trim());
      if (mounted.current) {
        setValue("");
        setPhase("submitted");
      }
    } catch (cause) {
      if (mounted.current) {
        setError(message(cause));
        setPhase("idle");
      }
      submitting.current = false;
    }
  };
  return (
    <form
      className="browser-auth-manual"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <strong>授权后没有自动返回？</strong>
      <p id={helpId}>
        {mode === "claude"
          ? "将授权页面显示的完整授权码（code#state），或浏览器返回的完整回调地址粘贴到下方。"
          : "将浏览器地址栏中以 http://localhost 开头的完整回调地址粘贴到下方。"}
      </p>
      <label htmlFor={fieldId}>
        {mode === "claude" ? "授权码或回调地址" : "回调地址"}
      </label>
      <textarea
        id={fieldId}
        rows={3}
        value={value}
        maxLength={16384}
        autoComplete="off"
        spellCheck={false}
        placeholder={
          mode === "claude" ? "粘贴完整授权码或回调地址" : "粘贴完整回调地址"
        }
        readOnly={phase !== "idle"}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? helpId + " " + errorId : helpId}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
      />
      {error && (
        <p id={errorId} className="browser-auth-error" role="alert">
          {error}
        </p>
      )}
      {phase === "submitted" && (
        <p className="browser-auth-status" role="status">
          <Check size={14} aria-hidden="true" />
          已提交，正在等待官方登录确认…
        </p>
      )}
      <Button
        type="submit"
        size="sm"
        disabled={phase !== "idle" || !value.trim()}
      >
        {phase === "submitting" && (
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        )}
        {phase === "submitting"
          ? "正在提交…"
          : phase === "submitted"
            ? "已提交"
            : "提交授权结果"}
      </Button>
    </form>
  );
}
