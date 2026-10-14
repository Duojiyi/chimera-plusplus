import { useId, useState } from "react";
import { AlertTriangle, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { SessionMessage, SessionMeta } from "@/types";
import { buildSessionExport } from "./utils";

interface SessionExportButtonProps {
  session: SessionMeta;
  messages: SessionMessage[];
  /** Why exporting is not possible right now, or null when it is. */
  unavailableReason: string | null;
}

function download(fileName: string, content: string) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(
    new Blob([content], { type: "application/json;charset=utf-8" }),
  );
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Let the WebView consume the download before releasing its URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/**
 * Exports the loaded conversation as JSON. Tool output is opt-in, with the
 * risk stated in plain view next to the switch rather than in a tooltip.
 */
export function SessionExportButton({
  session,
  messages,
  unavailableReason,
}: SessionExportButtonProps) {
  const checkboxId = useId();
  const [open, setOpen] = useState(false);
  const [includeToolOutput, setIncludeToolOutput] = useState(false);

  const handleExport = () => {
    const payload = buildSessionExport(session, messages, {
      includeToolOutput,
    });
    download(
      `session-${session.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100)}.json`,
      JSON.stringify(payload, null, 2),
    );
    setOpen(false);
  };

  if (unavailableReason !== null) {
    // A disabled button gets no hover, so the reason sits on its wrapper.
    return (
      <span className="inline-flex" title={unavailableReason}>
        <Button size="sm" variant="ghost" className="gap-1.5" disabled>
          <Download className="size-3.5" aria-hidden />
          导出
        </Button>
      </span>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setIncludeToolOutput(false);
      }}
    >
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="gap-1.5">
          <Download className="size-3.5" aria-hidden />
          导出
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="session-export-popover">
        <p className="session-export-title">导出为 JSON</p>
        <p className="session-export-copy">
          包含已读取的对话文字。默认不含工具输出和记录文件在本机的位置。
        </p>
        <label htmlFor={checkboxId} className="session-export-option">
          <Checkbox
            id={checkboxId}
            checked={includeToolOutput}
            onCheckedChange={(value) => setIncludeToolOutput(value === true)}
          />
          <span>包含工具输出（可能含密钥或令牌）</span>
        </label>
        {includeToolOutput ? (
          <p className="session-export-warning" role="note">
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
            <span>
              工具输出可能含有密钥、令牌或本机文件内容，分享文件前请逐条检查。
            </span>
          </p>
        ) : null}
        <div className="session-export-actions">
          <Button size="sm" onClick={handleExport}>
            导出 JSON
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
