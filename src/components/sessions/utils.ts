import type { ReactNode } from "react";
import { createElement } from "react";
import type {
  SessionListEntry,
  SessionTranscriptEntry,
} from "@/lib/api/sessions";
import type { SessionMessage, SessionMeta } from "@/types";

const CODEX_IDE_CONTEXT_PREFIX = "# Context from my IDE setup:";
const CODEX_REQUEST_MARKER = "my request for codex";
export const UNKNOWN_PROJECT_DIR_KEY = "__unknown_project_dir__";

/** Role of the entries the reader adds when it leaves content out. */
export const NOTICE_ROLE = "notice";

/** Product names, the same ones the 应用 filter offers. */
const PROVIDER_NAMES: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  grokbuild: "Grok Build",
};

/** Tools whose deletes also remove sub-sessions they spawned. */
const PROVIDERS_WITH_SUB_SESSIONS = new Set(["codex", "claude"]);

const DATE_TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const MONTH_DAY_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  month: "long",
  day: "numeric",
});
const FULL_DATE_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

export interface SessionDirectoryGroup {
  key: string;
  projectDir: string | null;
  label: string;
  sessions: SessionMeta[];
}

export interface SessionProviderGroup {
  providerId: string;
  sessions: SessionMeta[];
  directories: SessionDirectoryGroup[];
}

const getCodexRequestHeadingPayload = (lineText: string) => {
  if (!lineText.startsWith("#")) return null;

  const heading = lineText.replace(/^#+\s*/, "");
  const suffix = heading.toLowerCase().startsWith(CODEX_REQUEST_MARKER)
    ? heading.slice(CODEX_REQUEST_MARKER.length).trimStart()
    : null;

  if (suffix === null) return null;
  if (!suffix) return "";
  if (!/^[:：\-—]/.test(suffix)) return null;

  return suffix.replace(/^[:：\-—\s]+/, "").trim();
};

const extractCodexPromptFromIdeContext = (content: string) => {
  const trimmed = content.trim();
  if (!trimmed.startsWith(CODEX_IDE_CONTEXT_PREFIX)) {
    return null;
  }

  // VS Code injects the real prompt as the LAST "## My request for Codex:"
  // section, so keep the final matching heading. Earlier matches can be
  // headings that live inside the active selection / open file content.
  // Trade-off: if the request body itself repeats the heading, the preview
  // truncates to its trailing part (rare; see sessionUtils.test.ts).
  const lines = trimmed.replace(/\r\n/g, "\n").split("\n");
  let prompt: string | null = null;
  for (const [index, line] of lines.entries()) {
    const inlinePrompt = getCodexRequestHeadingPayload(line.trim());
    if (inlinePrompt === null) continue;

    if (inlinePrompt) {
      prompt = inlinePrompt;
      continue;
    }

    const followingPrompt = lines
      .slice(index + 1)
      .join("\n")
      .trim();
    prompt = followingPrompt || null;
  }

  return prompt;
};

export const getSessionKey = (session: SessionMeta) =>
  `${session.providerId}:${session.sessionId}:${session.sourcePath ?? ""}`;

export const getSessionDirectoryGroupKey = (
  providerId: string,
  projectDir?: string | null,
) => {
  const trimmed = projectDir?.trim();
  return `${providerId}:${trimmed || UNKNOWN_PROJECT_DIR_KEY}`;
};

export const getBaseName = (value?: string | null) => {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const normalized = trimmed.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || trimmed;
};

/** The UI is Simplified Chinese, so dates are too, whatever the OS locale. */
export const formatTimestamp = (value?: number) => {
  if (!value) return "";
  return DATE_TIME_FORMAT.format(value);
};

export const formatRelativeTime = (
  value: number | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
) => {
  if (!value) return "";
  const now = Date.now();
  const diff = now - value;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return t("sessionManager.justNow");
  if (minutes < 60) return t("sessionManager.minutesAgo", { count: minutes });
  if (hours < 24) return t("sessionManager.hoursAgo", { count: hours });
  if (days < 7) return t("sessionManager.daysAgo", { count: days });
  const sameYear =
    new Date(value).getFullYear() === new Date(now).getFullYear();
  return (sameYear ? MONTH_DAY_FORMAT : FULL_DATE_FORMAT).format(value);
};

export const getProviderLabel = (providerId: string) =>
  PROVIDER_NAMES[providerId] ?? providerId;

// 根据 providerId 获取对应的图标名称
export const getProviderIconName = (providerId: string) => {
  if (providerId === "codex") return "openai";
  if (providerId === "grokbuild") return "grok";
  return providerId;
};

export const isArchivedSession = (session: SessionMeta) =>
  (session as SessionListEntry).archived === true;

export const isTruncatedMessage = (message: SessionMessage) =>
  (message as SessionTranscriptEntry).truncated === true;

export const isNoticeMessage = (message: SessionMessage) =>
  message.role === NOTICE_ROLE;

export const hasSubSessions = (session: SessionMeta) =>
  PROVIDERS_WITH_SUB_SESSIONS.has(session.providerId);

/** The first block of a UUID is enough to tell sessions apart at a glance. */
export const shortSessionId = (sessionId: string) => sessionId.slice(0, 8);

/**
 * The JSON export. Tool outputs (command results, file contents) and the
 * record's location on this computer are left out unless asked for: both can
 * carry secrets or personal paths into a file that gets shared.
 */
export const buildSessionExport = (
  session: SessionMeta,
  messages: SessionMessage[],
  { includeToolOutput }: { includeToolOutput: boolean },
) => {
  const exportedSession: SessionMeta = { ...session };
  delete exportedSession.sourcePath;
  return {
    version: 1,
    session: exportedSession,
    messages: includeToolOutput
      ? messages
      : messages.filter((message) => message.role.toLowerCase() !== "tool"),
  };
};

export interface SessionReadFailure {
  /** The record is beyond what the reader accepts, not unreadable. */
  tooLarge: boolean;
  /** One plain sentence on the likely cause, or "" when it is unknown. */
  hint: string;
}

/** Turn a read error from the backend into something a person can act on. */
export const describeSessionReadError = (
  message: string,
): SessionReadFailure => {
  if (/exceeds byte limit/i.test(message)) {
    return {
      tooLarge: true,
      hint: "这条会话的压缩记录超过了可读取的上限。",
    };
  }
  if (/os error (32|33)\b|used by another process|正在使用/i.test(message)) {
    return {
      tooLarge: false,
      hint: "文件正被其他程序占用，请稍后重试。",
    };
  }
  if (
    /os error (5|13)\b|permission denied|access is denied|拒绝访问/i.test(
      message,
    )
  ) {
    return { tooLarge: false, hint: "没有读取这个文件的权限。" };
  }
  if (/os error (2|3)\b|not found|cannot find|找不到/i.test(message)) {
    return {
      tooLarge: false,
      hint: "记录文件已不存在，可能已被移动或删除。刷新列表后再试。",
    };
  }
  return { tooLarge: false, hint: "" };
};

export const getRoleLabel = (role: string) => {
  const normalized = role.toLowerCase();
  if (normalized === "assistant") return "AI";
  if (normalized === "user") return "用户";
  if (normalized === "system") return "系统";
  if (normalized === "tool") return "工具输出";
  return role;
};

export const formatSessionTitle = (session: SessionMeta) => {
  return (
    session.title ||
    getBaseName(session.projectDir) ||
    session.sessionId.slice(0, 8)
  );
};

export const groupSessionsByProviderAndDirectory = (
  sessions: SessionMeta[],
  unknownDirectoryLabel: string,
): SessionProviderGroup[] => {
  const providerGroups: SessionProviderGroup[] = [];
  const providerGroupMap = new Map<string, SessionProviderGroup>();
  const directoryGroupMaps = new Map<
    string,
    Map<string, SessionDirectoryGroup>
  >();

  sessions.forEach((session) => {
    let providerGroup = providerGroupMap.get(session.providerId);
    if (!providerGroup) {
      providerGroup = {
        providerId: session.providerId,
        sessions: [],
        directories: [],
      };
      providerGroupMap.set(session.providerId, providerGroup);
      providerGroups.push(providerGroup);
      directoryGroupMaps.set(session.providerId, new Map());
    }

    providerGroup.sessions.push(session);

    const trimmedProjectDir = session.projectDir?.trim() || null;
    const directoryKey = getSessionDirectoryGroupKey(
      session.providerId,
      trimmedProjectDir,
    );
    const directoryGroups = directoryGroupMaps.get(session.providerId)!;

    let directoryGroup = directoryGroups.get(directoryKey);
    if (!directoryGroup) {
      directoryGroup = {
        key: directoryKey,
        projectDir: trimmedProjectDir,
        label: trimmedProjectDir
          ? getBaseName(trimmedProjectDir) || trimmedProjectDir
          : unknownDirectoryLabel,
        sessions: [],
      };
      directoryGroups.set(directoryKey, directoryGroup);
      providerGroup.directories.push(directoryGroup);
    }

    directoryGroup.sessions.push(session);
  });

  return providerGroups;
};

export const shouldHideCodexMessageFromToc = (content: string) => {
  const trimmed = content.trim();
  return (
    trimmed.startsWith("# AGENTS.md instructions for ") ||
    trimmed.startsWith("<environment_context>") ||
    (trimmed.startsWith(CODEX_IDE_CONTEXT_PREFIX) &&
      !extractCodexPromptFromIdeContext(trimmed))
  );
};

export const extractCodexPromptPreview = (content: string) => {
  return extractCodexPromptFromIdeContext(content) ?? content;
};

export const formatSessionMessagePreview = (
  content: string,
  maxLength = 50,
) => {
  return (
    content.slice(0, maxLength) + (content.length > maxLength ? "..." : "")
  );
};

export const highlightText = (text: string, query: string): ReactNode => {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1
      ? createElement(
          "mark",
          {
            key: i,
            className:
              "bg-yellow-200/60 dark:bg-yellow-500/30 text-inherit rounded-sm px-0.5",
          },
          part,
        )
      : part,
  );
};
