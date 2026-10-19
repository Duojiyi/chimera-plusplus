import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { sessionsApi } from "@/lib/api/sessions";
import type { SessionMessage, SessionMeta } from "@/types";
import {
  buildSessionExport,
  buildSessionMarkdown,
  getSessionKey,
} from "./utils";

interface SessionExportButtonProps {
  session: SessionMeta;
  messages: SessionMessage[];
  unavailableReason: string | null;
}

export function SessionExportButton({
  session,
  messages,
  unavailableReason,
}: SessionExportButtonProps) {
  const checkboxId = useId();
  const sessionKey = getSessionKey(session);
  const [openForSession, setOpenForSession] = useState<string | null>(null);
  const [format, setFormat] = useState<"markdown" | "json">("markdown");
  const [includeToolOutput, setIncludeToolOutput] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFile, setSavedFile] = useState<{
    sessionKey: string;
    path: string;
  } | null>(null);
  const savingRef = useRef(false);
  const mountedRef = useRef(false);
  const currentSessionRef = useRef(sessionKey);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    currentSessionRef.current = sessionKey;
    setOpenForSession(null);
    setIncludeToolOutput(false);
    setFormat("markdown");
    setSavedFile(null);
  }, [sessionKey]);

  const handleExport = async () => {
    if (savingRef.current || unavailableReason !== null) return;
    savingRef.current = true;
    setSaving(true);
    const exportSessionKey = sessionKey;
    const sessionLabel = session.title
      ? `${session.title}（${session.sessionId}）`
      : session.sessionId;
    try {
      const options = { includeToolOutput };
      const content =
        format === "markdown"
          ? buildSessionMarkdown(session, messages, options)
          : JSON.stringify(
              buildSessionExport(session, messages, options),
              null,
              2,
            );
      const fileName = `session-${session.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100)}.${format === "markdown" ? "md" : "json"}`;
      // Capture content and format before opening the native dialog. The
      // selected conversation may change while the dialog is still open.
      const path = await sessionsApi.exportFile({ fileName, format, content });
      if (!mountedRef.current || path === null) return;

      toast.success("会话导出成功", {
        description: `会话：${sessionLabel}\n已保存到：${path}`,
        duration: 10000,
      });
      if (currentSessionRef.current === exportSessionKey) {
        setSavedFile({ sessionKey: exportSessionKey, path });
        setOpenForSession(null);
        setIncludeToolOutput(false);
      }
    } catch (error) {
      if (mountedRef.current) {
        toast.error("会话导出失败", {
          description: `会话：${sessionLabel}\n${String(error)}`,
          duration: 10000,
        });
      }
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  const savedPath =
    savedFile?.sessionKey === sessionKey ? savedFile.path : null;

  return (
    <span className="session-export-control">
      <Popover
        open={openForSession === sessionKey}
        onOpenChange={(next) => {
          if (savingRef.current) return;
          setOpenForSession(next ? sessionKey : null);
          if (!next) setIncludeToolOutput(false);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="gap-1.5"
            title={unavailableReason ?? undefined}
            disabled={unavailableReason !== null || saving}
            aria-busy={saving}
          >
            <Download className="size-3.5" aria-hidden />
            {saving ? "保存中…" : "导出"}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="session-export-popover"
          aria-label="导出会话"
        >
          <p className="session-export-title">导出会话</p>
          <p className="session-export-copy">
            包含已读取的对话文字。默认不含工具输出和记录文件在本机的位置。
          </p>
          <div
            className="session-export-formats"
            role="group"
            aria-label="导出格式"
          >
            <Button
              type="button"
              size="sm"
              variant={format === "markdown" ? "secondary" : "ghost"}
              aria-pressed={format === "markdown"}
              disabled={saving}
              onClick={() => setFormat("markdown")}
            >
              Markdown
            </Button>
            <Button
              type="button"
              size="sm"
              variant={format === "json" ? "secondary" : "ghost"}
              aria-pressed={format === "json"}
              disabled={saving}
              onClick={() => setFormat("json")}
            >
              JSON
            </Button>
          </div>
          <label htmlFor={checkboxId} className="session-export-option">
            <Checkbox
              id={checkboxId}
              checked={includeToolOutput}
              disabled={saving}
              onCheckedChange={(value) => setIncludeToolOutput(value === true)}
            />
            <span>包含工具输出（可能含密钥或令牌）</span>
          </label>
          {includeToolOutput && (
            <p className="session-export-warning" role="note">
              <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
              <span>
                工具输出可能含有密钥、令牌或本机文件内容，分享文件前请逐条检查。
              </span>
            </p>
          )}
          <p className="session-export-copy">
            下一步将打开“另存为”，由你选择文件夹和文件名。
          </p>
          <div className="session-export-actions">
            <Button
              type="button"
              size="sm"
              disabled={saving || unavailableReason !== null}
              onClick={() => void handleExport()}
            >
              {saving
                ? "保存中…"
                : `保存 ${format === "markdown" ? "Markdown" : "JSON"}…`}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {savedPath && (
        <span
          className="session-export-location"
          role="status"
          title={savedPath}
        >
          已保存到：{savedPath}
        </span>
      )}
    </span>
  );
}
