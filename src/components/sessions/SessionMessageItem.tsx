import { memo, useState } from "react";
import { ChevronDown, ChevronUp, Copy, Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { SessionMessage } from "@/types";
import { SessionMessageContent } from "./SessionMessageContent";
import {
  formatTimestamp,
  getRoleLabel,
  isNoticeMessage,
  isTruncatedMessage,
  shouldHideCodexMessageFromToc,
  highlightText,
} from "./utils";

const COLLAPSE_THRESHOLD = 1800;
const COLLAPSED_LENGTH = 600;
const TOOL_CALL = /^\[Tool: ([^\]\n]+)\]$/;

interface SessionMessageItemProps {
  message: SessionMessage;
  isActive: boolean;
  searchQuery?: string;
  onCopy: (content: string) => void;
}

export const SessionMessageItem = memo(function SessionMessageItem({
  message,
  isActive,
  searchQuery,
  onCopy,
}: SessionMessageItemProps) {
  const [expanded, setExpanded] = useState(false);

  // What the reader left out is said in place, not dressed up as a message.
  if (isNoticeMessage(message)) {
    return (
      <div className="session-message-notice" role="note">
        <Info className="size-3.5 shrink-0" aria-hidden />
        <span>{message.content}</span>
      </div>
    );
  }

  const role = message.role.toLowerCase();
  const toolCall =
    role === "assistant" ? TOOL_CALL.exec(message.content) : null;
  if (toolCall) {
    return (
      <div
        className={cn(
          "session-tool-call",
          isActive && "session-message-active",
        )}
      >
        <span className="session-tool-call-label">调用工具</span>
        <code>{highlightText(toolCall[1], searchQuery ?? "")}</code>
        {message.ts ? (
          <span className="session-message-time">
            {formatTimestamp(message.ts)}
          </span>
        ) : null}
      </div>
    );
  }

  const isContext =
    role === "developer" ||
    role === "system" ||
    shouldHideCodexMessageFromToc(message.content);
  const isTool = role === "tool";
  const isLong = isContext || message.content.length > COLLAPSE_THRESHOLD;
  const hasSearchMatch =
    isLong &&
    !expanded &&
    !!searchQuery &&
    message.content.toLowerCase().includes(searchQuery.toLowerCase());
  const collapsed = isLong && !expanded && !hasSearchMatch;
  const truncated = isTruncatedMessage(message);

  return (
    <div
      className={cn(
        "session-message relative group min-w-0",
        isContext
          ? "session-message-context"
          : role === "user"
            ? "session-message-user"
            : isTool
              ? "session-message-tool"
              : "session-message-assistant",
        isActive && "session-message-active",
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-2 right-2 size-7 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-opacity"
            aria-label="复制内容"
            onClick={() => onCopy(message.content)}
          >
            <Copy className="size-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>复制内容</TooltipContent>
      </Tooltip>
      <div className="flex items-center justify-between gap-3 text-xs mb-1.5 pr-8">
        <span className="flex items-center gap-2 min-w-0">
          <span className="session-message-role">
            {isContext ? "系统与环境" : getRoleLabel(message.role)}
          </span>
          {truncated ? (
            <span
              className="session-tag"
              title="这条输出过长，只显示了开头部分"
            >
              已截断
            </span>
          ) : null}
        </span>
        {message.ts ? (
          <span className="session-message-time">
            {formatTimestamp(message.ts)}
          </span>
        ) : null}
      </div>
      {collapsed && isContext ? (
        <p className="session-message-collapsed-note">
          会话的系统指令与环境信息已折叠，可展开查看完整记录。
        </p>
      ) : (
        <SessionMessageContent
          content={
            collapsed
              ? message.content.slice(0, COLLAPSED_LENGTH) + "…"
              : message.content
          }
          monospace={isTool}
          searchQuery={searchQuery}
        />
      )}
      {isLong && !hasSearchMatch && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="session-message-toggle"
        >
          {expanded ? (
            <>
              <ChevronUp className="size-3" aria-hidden />
              收起
            </>
          ) : (
            <>
              <ChevronDown className="size-3" aria-hidden />
              展开完整内容
              <span className="session-message-toggle-size">
                （{message.content.length.toLocaleString("zh-CN")} 字符）
              </span>
            </>
          )}
        </button>
      )}
    </div>
  );
});
