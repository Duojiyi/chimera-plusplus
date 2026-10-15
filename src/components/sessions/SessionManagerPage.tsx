import "./SessionManagerPage.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSessionSearch } from "@/hooks/useSessionSearch";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  CheckSquare,
  Clock,
  Copy,
  FileText,
  FolderOpen,
  Info,
  LayoutGrid,
  List,
  ListTree,
  MessageSquare,
  Play,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useSessionMessagesQuery, useSessionsQuery } from "@/lib/query";
import { sessionsApi } from "@/lib/api";
import type { SessionMeta } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { extractErrorMessage } from "@/utils/errorUtils";
import { isMac } from "@/lib/platform";
import { ProviderIcon } from "@/components/ProviderIcon";
import {
  SessionDeleteDialog,
  type SessionDeleteTarget,
} from "./SessionDeleteDialog";
import { SessionExportButton } from "./SessionExportButton";
import { SessionItem } from "./SessionItem";
import { SessionMessageItem } from "./SessionMessageItem";
import { SessionTocDialog, SessionTocSidebar } from "./SessionToc";
import {
  describeSessionReadError,
  extractCodexPromptPreview,
  formatSessionMessagePreview,
  formatSessionTitle,
  formatTimestamp,
  getBaseName,
  getProviderIconName,
  getProviderLabel,
  getSessionDirectoryGroupKey,
  getSessionKey,
  groupSessionsByProviderAndDirectory,
  isArchivedSession,
  isNoticeMessage,
  isTruncatedMessage,
  type SessionDirectoryGroup,
  type SessionProviderGroup,
  shouldHideCodexMessageFromToc,
} from "./utils";

const SESSION_LIST_VIEW_MODE_STORAGE_KEY =
  "cc-switch.sessionManager.listViewMode";
const SESSION_GROUP_EXPANSION_STORAGE_KEY =
  "cc-switch.sessionManager.groupExpansionState";

type ProviderFilter =
  "all" | "codex" | "grokbuild" | "claude" | "opencode" | "gemini";

const PROVIDER_FILTERS: ProviderFilter[] = [
  "codex",
  "claude",
  "gemini",
  "opencode",
  "grokbuild",
];

type SessionListViewMode = "flat" | "grouped";

type GroupSelectionState = {
  checked: boolean | "indeterminate";
  isSelected: boolean;
  selectedCount: number;
  selectableCount: number;
};

type SessionGroupExpansionState = {
  expandedProviderIds: Set<string>;
  expandedDirectoryKeys: Set<string>;
};

const readInitialSessionListViewMode = (): SessionListViewMode => {
  if (typeof window === "undefined") return "flat";
  const stored = window.localStorage.getItem(
    SESSION_LIST_VIEW_MODE_STORAGE_KEY,
  );
  return stored === "grouped" || stored === "flat" ? stored : "flat";
};

const readInitialSessionGroupExpansionState =
  (): SessionGroupExpansionState => {
    if (typeof window === "undefined") {
      return {
        expandedProviderIds: new Set(),
        expandedDirectoryKeys: new Set(),
      };
    }

    try {
      const stored = window.localStorage.getItem(
        SESSION_GROUP_EXPANSION_STORAGE_KEY,
      );
      const parsed = stored ? JSON.parse(stored) : null;

      if (!parsed || typeof parsed !== "object") {
        return {
          expandedProviderIds: new Set(),
          expandedDirectoryKeys: new Set(),
        };
      }

      const expandedProviderIds = Array.isArray(parsed.expandedProviderIds)
        ? parsed.expandedProviderIds.filter(
            (providerId: unknown): providerId is string =>
              typeof providerId === "string",
          )
        : [];
      const expandedDirectoryKeys = Array.isArray(parsed.expandedDirectoryKeys)
        ? parsed.expandedDirectoryKeys.filter(
            (directoryKey: unknown): directoryKey is string =>
              typeof directoryKey === "string",
          )
        : [];

      return {
        expandedProviderIds: new Set(expandedProviderIds),
        expandedDirectoryKeys: new Set(expandedDirectoryKeys),
      };
    } catch {
      return {
        expandedProviderIds: new Set(),
        expandedDirectoryKeys: new Set(),
      };
    }
  };

const serializeSessionGroupExpansionState = (
  expandedProviderGroups: Set<string>,
  expandedDirectoryGroups: Set<string>,
) =>
  JSON.stringify({
    expandedProviderIds: Array.from(expandedProviderGroups).sort(),
    expandedDirectoryKeys: Array.from(expandedDirectoryGroups).sort(),
  });

const filterSetToAllowedValues = (
  current: Set<string>,
  allowedValues: Set<string>,
) => {
  let changed = false;
  const next = new Set<string>();

  current.forEach((value) => {
    if (allowedValues.has(value)) {
      next.add(value);
    } else {
      changed = true;
    }
  });

  return changed ? next : current;
};

/** What the retry banner says about deletes that did not finish. */
const describeUnfinishedDeletes = (targets: SessionDeleteTarget[]) => {
  const cleanup = targets.filter((target) => target.contentDeleted).length;
  const failed = targets.length - cleanup;
  if (failed === 0) {
    return `${cleanup} 个会话的内容已删除，但索引清理未完成。请关闭 Codex 后重试。`;
  }
  if (cleanup === 0) {
    return `${failed} 个会话删除失败，仍保留在列表中。`;
  }
  return `${cleanup} 个会话待完成索引清理，${failed} 个会话删除失败。`;
};

export function SessionManagerPage({ appId }: { appId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const {
    data,
    isLoading,
    isError: isListError,
    error: listError,
    isFetching: isFetchingList,
    refetch,
  } = useSessionsQuery();
  const sessions = useMemo(() => data ?? [], [data]);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const deleteInFlightRef = useRef(false);
  const [activeMessageIndex, setActiveMessageIndex] = useState<number | null>(
    null,
  );
  const [tocDialogOpen, setTocDialogOpen] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<
    SessionDeleteTarget[] | null
  >(null);
  const [selectedSessionKeys, setSelectedSessionKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteRetryTargets, setDeleteRetryTargets] = useState<
    SessionDeleteTarget[]
  >([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [isReclaiming, setIsReclaiming] = useState(false);
  const [reclaimConfirmOpen, setReclaimConfirmOpen] = useState(false);

  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>(
    appId as ProviderFilter,
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [listViewMode, setListViewMode] = useState<SessionListViewMode>(
    readInitialSessionListViewMode,
  );
  const [initialGroupExpansionState] = useState(
    readInitialSessionGroupExpansionState,
  );
  const [expandedProviderGroups, setExpandedProviderGroups] = useState<
    Set<string>
  >(() => initialGroupExpansionState.expandedProviderIds);
  const [expandedDirectoryGroups, setExpandedDirectoryGroups] = useState<
    Set<string>
  >(() => initialGroupExpansionState.expandedDirectoryKeys);

  // 使用 FlexSearch 全文搜索
  const { search: searchSessions } = useSessionSearch({
    sessions,
    providerFilter,
  });

  const filteredSessions = useMemo(() => {
    return searchSessions(search);
  }, [searchSessions, search]);

  // With one application chosen, its name above every folder says nothing.
  const singleProvider = providerFilter !== "all";
  const groupedSessions = useMemo(
    () =>
      groupSessionsByProviderAndDirectory(
        filteredSessions,
        t("sessionManager.unknownDirectory", {
          defaultValue: "未知目录",
        }),
      ),
    [filteredSessions, t],
  );

  const validGroupExpansionKeys = useMemo(
    () => ({
      providerIds: new Set(sessions.map((session) => session.providerId)),
      directoryKeys: new Set(
        sessions.map((session) =>
          getSessionDirectoryGroupKey(session.providerId, session.projectDir),
        ),
      ),
    }),
    [sessions],
  );

  useEffect(() => {
    window.localStorage.setItem(
      SESSION_LIST_VIEW_MODE_STORAGE_KEY,
      listViewMode,
    );
  }, [listViewMode]);

  useEffect(() => {
    window.localStorage.setItem(
      SESSION_GROUP_EXPANSION_STORAGE_KEY,
      serializeSessionGroupExpansionState(
        expandedProviderGroups,
        expandedDirectoryGroups,
      ),
    );
  }, [expandedDirectoryGroups, expandedProviderGroups]);

  useEffect(() => {
    if (isLoading) return;

    setExpandedProviderGroups((current) =>
      filterSetToAllowedValues(current, validGroupExpansionKeys.providerIds),
    );
    setExpandedDirectoryGroups((current) =>
      filterSetToAllowedValues(current, validGroupExpansionKeys.directoryKeys),
    );
  }, [isLoading, validGroupExpansionKeys]);

  useEffect(() => {
    if (filteredSessions.length === 0) {
      setSelectedKey(null);
      return;
    }
    const exists = selectedKey
      ? filteredSessions.some(
          (session) => getSessionKey(session) === selectedKey,
        )
      : false;
    if (!exists) {
      setSelectedKey(getSessionKey(filteredSessions[0]));
    }
  }, [filteredSessions, selectedKey]);

  const selectedSession = useMemo(() => {
    if (!selectedKey) return null;
    return (
      filteredSessions.find(
        (session) => getSessionKey(session) === selectedKey,
      ) || null
    );
  }, [filteredSessions, selectedKey]);

  const listViewModeLabel = listViewMode === "grouped" ? "分类" : "列表";

  const {
    data: messages = [],
    isLoading: isLoadingMessages,
    isError: isMessagesError,
    error: messagesError,
    isFetching: isFetchingMessages,
    refetch: refetchMessages,
  } = useSessionMessagesQuery(
    selectedSession?.providerId,
    selectedSession?.sourcePath,
  );

  const exportUnavailableReason =
    isLoadingMessages || isFetchingMessages
      ? "正在读取对话，读取完成后可以导出"
      : isMessagesError
        ? "对话读取失败，无法导出"
        : messages.length === 0
          ? "这条会话没有可以导出的对话"
          : null;
  const contentTruncated = useMemo(
    () =>
      messages.some(
        (message) => isNoticeMessage(message) || isTruncatedMessage(message),
      ),
    [messages],
  );
  const readFailure = useMemo(
    () =>
      isMessagesError
        ? describeSessionReadError(extractErrorMessage(messagesError) || "")
        : null,
    [isMessagesError, messagesError],
  );

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 120,
    overscan: 5,
    gap: 12,
  });

  // Long histories stay cheap: only the rows in view are rendered.
  const listVirtualizer = useVirtualizer({
    count: listViewMode === "flat" ? filteredSessions.length : 0,
    getScrollElement: () => listScrollRef.current,
    estimateSize: () => 64,
    overscan: 8,
    gap: 2,
    getItemKey: (index) => getSessionKey(filteredSessions[index]),
  });

  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [selectedKey]);

  useEffect(() => {
    if (listScrollRef.current) {
      listScrollRef.current.scrollTop = 0;
    }
  }, [search, providerFilter, listViewMode]);

  useEffect(() => {
    const validKeys = new Set(
      sessions.map((session) => getSessionKey(session)),
    );
    setSelectedSessionKeys((current) => {
      let changed = false;
      const next = new Set<string>();
      current.forEach((key) => {
        if (validKeys.has(key)) {
          next.add(key);
        } else {
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [sessions]);

  const isCodexSession = selectedSession?.providerId === "codex";

  // 提取用户消息用于目录
  const userMessagesToc = useMemo(() => {
    return messages
      .map((msg, index) => ({ msg, index }))
      .filter(({ msg }) => {
        if (msg.role.toLowerCase() !== "user") return false;
        return !(isCodexSession && shouldHideCodexMessageFromToc(msg.content));
      })
      .map(({ msg, index }) => {
        const previewContent = isCodexSession
          ? extractCodexPromptPreview(msg.content)
          : msg.content;

        return {
          index,
          preview: formatSessionMessagePreview(previewContent),
          ts: msg.ts,
        };
      });
  }, [isCodexSession, messages]);

  const scrollToMessage = (index: number) => {
    virtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
    setActiveMessageIndex(index);
    setTocDialogOpen(false);
    setTimeout(() => setActiveMessageIndex(null), 2000);
  };

  const handleCopy = useCallback(
    async (text: string, successMessage: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast.success(successMessage);
      } catch (error) {
        toast.error(extractErrorMessage(error) || "复制失败");
      }
    },
    [],
  );

  const handleMessageCopy = useCallback(
    (content: string) => {
      void handleCopy(content, "已复制消息内容");
    },
    [handleCopy],
  );

  const handleResume = async () => {
    if (!selectedSession?.resumeCommand) return;

    if (!isMac()) {
      await handleCopy(
        selectedSession.resumeCommand,
        t("sessionManager.resumeCommandCopied"),
      );
      return;
    }

    try {
      await sessionsApi.launchTerminal({
        command: selectedSession.resumeCommand,
        cwd: selectedSession.projectDir ?? undefined,
      });
      toast.success(t("sessionManager.terminalLaunched"));
    } catch (error) {
      const fallback = selectedSession.resumeCommand;
      await handleCopy(fallback, t("sessionManager.resumeFallbackCopied"));
      toast.error(extractErrorMessage(error) || t("sessionManager.openFailed"));
    }
  };

  const requestDelete = (targets: SessionMeta[]) => {
    const deletable = targets.filter((session) => session.sourcePath);
    if (deletable.length > 0) {
      setDeleteTargets(deletable.map((session) => ({ session })));
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTargets?.length || deleteInFlightRef.current) return;

    const targets = deleteTargets.filter(({ session }) => session.sourcePath);
    setDeleteTargets(null);
    if (!targets.length) return;

    deleteInFlightRef.current = true;
    setIsDeleting(true);
    try {
      // Use the structured contract for single deletes too: the legacy boolean
      // cannot distinguish deleted content from unfinished index cleanup.
      const results = await sessionsApi.deleteMany(
        targets.map(({ session }) => ({
          providerId: session.providerId,
          sessionId: session.sessionId,
          sourcePath: session.sourcePath!,
        })),
      );
      const outcomes = new Map(
        results.map((result) => [getSessionKey(result), result]),
      );
      const unfinished = targets.flatMap((target) => {
        const outcome = outcomes.get(getSessionKey(target.session));
        if (outcome?.success) return [];
        return [
          {
            session: target.session,
            contentDeleted:
              target.contentDeleted === true || outcome?.sourceDeleted === true,
          },
        ];
      });
      const targetKeys = new Set(
        targets.map(({ session }) => getSessionKey(session)),
      );
      // Retain identities independently of the scanned list: a deleted source
      // can disappear while its index cleanup still needs an explicit retry.
      setDeleteRetryTargets((current) => [
        ...current.filter(
          ({ session }) => !targetKeys.has(getSessionKey(session)),
        ),
        ...unfinished,
      ]);

      const contentDeleted = results.filter(
        (result) => result.success || result.sourceDeleted === true,
      );
      const deletedKeys = new Set(contentDeleted.map(getSessionKey));
      if (deletedKeys.size > 0) {
        queryClient.setQueryData<SessionMeta[]>(["sessions"], (current) =>
          (current ?? []).filter(
            (session) => !deletedKeys.has(getSessionKey(session)),
          ),
        );
        contentDeleted.forEach((result) => {
          queryClient.removeQueries({
            queryKey: ["sessionMessages", result.providerId, result.sourcePath],
          });
        });
        setSelectedSessionKeys(
          (current) =>
            new Set([...current].filter((key) => !deletedKeys.has(key))),
        );
      }
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });

      const completed = results.filter((result) => result.success).length;
      const cleanupPending = results.filter(
        (result) => !result.success && result.cleanupPending === true,
      );
      if (completed > 0) {
        toast.success(
          t("sessionManager.batchDeleteSuccess", {
            defaultValue: "已删除 {{count}} 个会话",
            count: completed,
          }),
        );
      }
      // Finished deletes that left some records on purpose: say what stayed
      // and why, without offering a retry that cannot help.
      const notes = results.filter(
        (result) => result.success && result.cleanupNote,
      );
      if (notes.length > 0) {
        toast.info(`${notes.length} 个会话已删除，部分记录未清理`, {
          description: notes[0].cleanupNote,
        });
      }
      if (cleanupPending.length > 0) {
        toast.warning(
          `${cleanupPending.length} 个会话的内容已删除，索引清理未完成。请关闭 Codex 后点「重试未完成的删除」。`,
        );
      }
      const cleanupKeys = new Set(cleanupPending.map(getSessionKey));
      const failures = unfinished.filter(
        ({ session }) => !cleanupKeys.has(getSessionKey(session)),
      );
      if (failures.length > 0) {
        toast.error(
          t("sessionManager.batchDeleteFailed", {
            defaultValue: "{{failed}} 个会话删除失败",
            failed: failures.length,
          }),
          {
            description:
              outcomes.get(getSessionKey(failures[0].session))?.error ||
              "原因未知",
          },
        );
      }
    } catch (error) {
      // The request was refused as a whole (Codex still running, for one),
      // so nothing was deleted and the sessions are still listed: there is
      // no partial delete to offer a retry for.
      toast.error(
        extractErrorMessage(error) || "删除请求没有完成，会话均未删除。",
      );
    } finally {
      deleteInFlightRef.current = false;
      setIsDeleting(false);
    }
  };

  /**
   * 一键恢复所有历史会话。
   *
   * 切换中转供应商后 Codex 只列出与当前 model_provider 相同的会话，旧桶里的
   * 历史看起来「丢失」了。后端把这些桶统一改写为当前共享桶（改写前自动备份），
   * 会话便重新出现在列表里。
   */
  const handleReclaimHistory = async () => {
    setReclaimConfirmOpen(false);
    setIsReclaiming(true);
    try {
      const result = await sessionsApi.reclaimCodexHistory();

      if (result.skippedReason === "live_not_custom") {
        toast.error(
          t("sessionManager.reclaimLiveNotCustom", {
            defaultValue:
              "当前 Codex 线路未使用共享供应商标识，恢复会把历史移到看不见的分组。请先切换到一条第三方线路后重试。",
          }),
        );
        return;
      }
      if (result.skippedReason === "nothing_to_reclaim") {
        toast.info(
          t("sessionManager.reclaimNothing", {
            defaultValue: "没有需要恢复的历史会话，现有会话都已在当前分组中。",
          }),
        );
        return;
      }
      if (
        result.skippedReason &&
        result.skippedReason !== "deferred_active_session_files"
      ) {
        // 未知的跳过原因：reason 是内部标识（如 live_not_custom），不直接展示给
        // 用户；给一句通用说明，具体值留在日志里。
        toast.info(
          t("sessionManager.reclaimSkipped", {
            defaultValue: "本次没有执行恢复，请稍后重试或查看日志。",
          }),
        );
        return;
      }

      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      await refetch();

      if (
        result.deferredJsonlFiles > 0 ||
        result.skippedReason === "deferred_active_session_files"
      ) {
        toast.warning(
          t("sessionManager.reclaimDeferred", {
            defaultValue:
              "已恢复 {{files}} 个会话文件，仍有 {{deferred}} 个活跃会话文件延期处理。",
            files: result.reclaimedJsonlFiles,
            deferred: result.deferredJsonlFiles,
          }),
          {
            description: t("sessionManager.reclaimDeferredDetail", {
              defaultValue:
                "已更新 {{rows}} 条索引记录。请停止这些会话的写入后，再次点击恢复；活动文件不会被覆盖。",
              rows: result.reclaimedStateRows,
            }),
          },
        );
        return;
      }

      toast.success(
        t("sessionManager.reclaimSuccess", {
          defaultValue: "已恢复 {{files}} 个会话文件",
          files: result.reclaimedJsonlFiles,
        }),
        {
          description: t("sessionManager.reclaimSuccessDetail", {
            defaultValue:
              "同时更新 {{rows}} 条索引记录，来源分组：{{sources}}。原文件已备份。",
            rows: result.reclaimedStateRows,
            sources: result.sourceProviderIds.join("、"),
          }),
        },
      );
    } catch (error) {
      toast.error(
        extractErrorMessage(error) ||
          t("sessionManager.reclaimFailed", {
            defaultValue: "恢复历史会话失败，请稍后重试",
          }),
      );
    } finally {
      setIsReclaiming(false);
    }
  };

  const deletableFilteredSessions = useMemo(
    () => filteredSessions.filter((session) => Boolean(session.sourcePath)),
    [filteredSessions],
  );

  const selectedSessions = useMemo(
    () =>
      sessions.filter((session) =>
        selectedSessionKeys.has(getSessionKey(session)),
      ),
    [sessions, selectedSessionKeys],
  );

  const selectedDeletableSessions = useMemo(
    () => selectedSessions.filter((session) => Boolean(session.sourcePath)),
    [selectedSessions],
  );

  useEffect(() => {
    if (!selectionMode) return;

    const visibleKeys = new Set(
      deletableFilteredSessions.map((session) => getSessionKey(session)),
    );

    setSelectedSessionKeys((current) => {
      let changed = false;
      const next = new Set<string>();

      current.forEach((key) => {
        if (visibleKeys.has(key)) {
          next.add(key);
        } else {
          changed = true;
        }
      });

      return changed ? next : current;
    });
  }, [deletableFilteredSessions, selectionMode]);

  const allFilteredSelected =
    deletableFilteredSessions.length > 0 &&
    deletableFilteredSessions.every((session) =>
      selectedSessionKeys.has(getSessionKey(session)),
    );

  const getGroupSelectionState = (
    groupSessions: SessionMeta[],
  ): GroupSelectionState => {
    const selectableSessions = groupSessions.filter((session) =>
      Boolean(session.sourcePath),
    );
    const selectedCount = selectableSessions.filter((session) =>
      selectedSessionKeys.has(getSessionKey(session)),
    ).length;
    const isSelected =
      selectableSessions.length > 0 &&
      selectedCount === selectableSessions.length;

    return {
      checked:
        selectedCount === 0 ? false : isSelected ? true : "indeterminate",
      isSelected,
      selectedCount,
      selectableCount: selectableSessions.length,
    };
  };

  const toggleSessionChecked = (session: SessionMeta, checked: boolean) => {
    if (!session.sourcePath) return;
    const key = getSessionKey(session);
    setSelectedSessionKeys((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  };

  const toggleSessionGroupChecked = (
    groupSessions: SessionMeta[],
    checked: boolean,
  ) => {
    const selectableSessions = groupSessions.filter((session) =>
      Boolean(session.sourcePath),
    );
    if (selectableSessions.length === 0) return;

    setSelectedSessionKeys((current) => {
      const next = new Set(current);
      selectableSessions.forEach((session) => {
        const sessionKey = getSessionKey(session);
        if (checked) {
          next.add(sessionKey);
        } else {
          next.delete(sessionKey);
        }
      });
      return next;
    });
  };

  const toggleProviderGroup = (providerId: string) => {
    setExpandedProviderGroups((current) => {
      const next = new Set(current);
      if (next.has(providerId)) {
        next.delete(providerId);
      } else {
        next.add(providerId);
      }
      return next;
    });
  };

  const toggleDirectoryGroup = (directoryKey: string) => {
    setExpandedDirectoryGroups((current) => {
      const next = new Set(current);
      if (next.has(directoryKey)) {
        next.delete(directoryKey);
      } else {
        next.add(directoryKey);
      }
      return next;
    });
  };

  const handleCollapseAllGroups = () => {
    setExpandedProviderGroups(new Set());
    setExpandedDirectoryGroups(new Set());
  };

  const renderSessionItem = (session: SessionMeta, showFolder = true) => {
    const sessionKey = getSessionKey(session);
    const isSelected = selectedKey !== null && sessionKey === selectedKey;

    return (
      <SessionItem
        key={sessionKey}
        session={session}
        isSelected={isSelected}
        selectionMode={selectionMode}
        searchQuery={search}
        showFolder={showFolder}
        isChecked={selectedSessionKeys.has(sessionKey)}
        isCheckDisabled={!session.sourcePath}
        onSelect={setSelectedKey}
        onToggleChecked={(checked) => toggleSessionChecked(session, checked)}
      />
    );
  };

  const renderGroupSelectionBadge = (
    selectionState: GroupSelectionState,
    totalCount: number,
    variant: "secondary" | "outline",
  ) => (
    <Badge variant={variant} className="shrink-0 text-xs">
      {selectionMode
        ? `${selectionState.selectedCount}/${selectionState.selectableCount}`
        : totalCount}
    </Badge>
  );

  const renderProviderGroupCheckbox = (
    providerGroup: SessionProviderGroup,
    providerLabel: string,
    selectionState: GroupSelectionState,
  ) => {
    if (!selectionMode) return null;

    return (
      <Checkbox
        checked={selectionState.checked}
        disabled={selectionState.selectableCount === 0}
        aria-label={t("sessionManager.selectProviderGroupForBatch", {
          defaultValue: "选择 {{provider}} 供应商分组内会话",
          provider: providerLabel,
        })}
        onClick={(event) => event.stopPropagation()}
        onCheckedChange={() =>
          toggleSessionGroupChecked(
            providerGroup.sessions,
            !selectionState.isSelected,
          )
        }
      />
    );
  };

  const renderDirectoryGroupCheckbox = (
    directoryGroup: SessionDirectoryGroup,
    selectionState: GroupSelectionState,
  ) => {
    if (!selectionMode) return null;

    return (
      <Checkbox
        checked={selectionState.checked}
        disabled={selectionState.selectableCount === 0}
        aria-label={t("sessionManager.selectDirectoryGroupForBatch", {
          defaultValue: "选择 {{directory}} 目录分组内会话",
          directory: directoryGroup.label,
        })}
        onClick={(event) => event.stopPropagation()}
        onCheckedChange={() =>
          toggleSessionGroupChecked(
            directoryGroup.sessions,
            !selectionState.isSelected,
          )
        }
      />
    );
  };

  const renderDirectoryGroup = (directoryGroup: SessionDirectoryGroup) => {
    const directoryOpen = expandedDirectoryGroups.has(directoryGroup.key);
    const directorySelectionState = getGroupSelectionState(
      directoryGroup.sessions,
    );

    return (
      <Collapsible
        key={directoryGroup.key}
        open={directoryOpen}
        onOpenChange={() => toggleDirectoryGroup(directoryGroup.key)}
      >
        <div className="session-group-row is-folder">
          {renderDirectoryGroupCheckbox(
            directoryGroup,
            directorySelectionState,
          )}
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="session-group-trigger"
              aria-label={t("sessionManager.toggleDirectoryGroup", {
                defaultValue: "展开或折叠 {{directory}} 目录分组",
                directory: directoryGroup.label,
              })}
            >
              {directoryOpen ? (
                <ChevronDown className="size-3.5 shrink-0" aria-hidden />
              ) : (
                <ChevronRight className="size-3.5 shrink-0" aria-hidden />
              )}
              <FolderOpen className="size-3.5 shrink-0" aria-hidden />
              <span
                className="session-group-label"
                title={directoryGroup.projectDir ?? undefined}
              >
                {directoryGroup.label}
              </span>
              {renderGroupSelectionBadge(
                directorySelectionState,
                directoryGroup.sessions.length,
                "outline",
              )}
            </button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="session-group-children">
          {directoryGroup.sessions.map((session) =>
            renderSessionItem(session, false),
          )}
        </CollapsibleContent>
      </Collapsible>
    );
  };

  const renderProviderGroup = (providerGroup: SessionProviderGroup) => {
    const providerOpen = expandedProviderGroups.has(providerGroup.providerId);
    const providerLabel = getProviderLabel(providerGroup.providerId);
    const providerSelectionState = getGroupSelectionState(
      providerGroup.sessions,
    );

    return (
      <Collapsible
        key={providerGroup.providerId}
        open={providerOpen}
        onOpenChange={() => toggleProviderGroup(providerGroup.providerId)}
      >
        <div className="session-group-row is-app">
          {renderProviderGroupCheckbox(
            providerGroup,
            providerLabel,
            providerSelectionState,
          )}
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="session-group-trigger"
              aria-label={t("sessionManager.toggleProviderGroup", {
                defaultValue: "展开或折叠 {{provider}} 供应商分组",
                provider: providerLabel,
              })}
            >
              {providerOpen ? (
                <ChevronDown className="size-3.5 shrink-0" aria-hidden />
              ) : (
                <ChevronRight className="size-3.5 shrink-0" aria-hidden />
              )}
              <ProviderIcon
                icon={getProviderIconName(providerGroup.providerId)}
                name={providerGroup.providerId}
                size={16}
              />
              <span className="session-group-label">{providerLabel}</span>
              {renderGroupSelectionBadge(
                providerSelectionState,
                providerGroup.sessions.length,
                "secondary",
              )}
            </button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="session-group-children">
          {providerGroup.directories.map(renderDirectoryGroup)}
        </CollapsibleContent>
      </Collapsible>
    );
  };

  const handleToggleSelectAll = () => {
    setSelectedSessionKeys((current) => {
      const next = new Set(current);
      if (allFilteredSelected) {
        deletableFilteredSessions.forEach((session) =>
          next.delete(getSessionKey(session)),
        );
      } else {
        deletableFilteredSessions.forEach((session) =>
          next.add(getSessionKey(session)),
        );
      }
      return next;
    });
  };

  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedSessionKeys(new Set());
  };

  const clearSearch = () => {
    setSearch("");
    searchInputRef.current?.focus();
  };

  const listUnavailable = isListError && sessions.length === 0;
  const noSessionsAtAll = !isLoading && !isListError && sessions.length === 0;
  const codexRelevant = providerFilter === "all" || providerFilter === "codex";
  const selectedTitle = selectedSession
    ? formatSessionTitle(selectedSession)
    : "";

  const renderListBody = () => {
    if (isLoading) {
      return (
        <div className="session-list-skeleton" role="status">
          <span className="sr-only">正在读取会话列表…</span>
          {[0, 1, 2, 3, 4].map((row) => (
            <div key={row} className="session-skeleton-row" aria-hidden>
              <span />
              <span />
            </div>
          ))}
        </div>
      );
    }
    if (filteredSessions.length === 0) {
      return (
        <div className="session-list-empty">
          {search.trim() ? (
            <>
              <p>
                没有标题、摘要、文件夹或 ID 与「{search.trim()}」匹配的会话。
              </p>
              <Button variant="outline" size="sm" onClick={clearSearch}>
                清除搜索
              </Button>
            </>
          ) : singleProvider ? (
            <>
              <p>{getProviderLabel(providerFilter)} 还没有会话记录。</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setProviderFilter("all")}
              >
                查看全部应用
              </Button>
            </>
          ) : (
            <p>没有可以显示的会话。</p>
          )}
        </div>
      );
    }
    if (listViewMode === "grouped") {
      return (
        <div className="session-group-list">
          {singleProvider
            ? groupedSessions.flatMap((providerGroup) =>
                providerGroup.directories.map(renderDirectoryGroup),
              )
            : groupedSessions.map(renderProviderGroup)}
        </div>
      );
    }
    return (
      <div
        style={{
          height: listVirtualizer.getTotalSize(),
          position: "relative",
        }}
      >
        {listVirtualizer.getVirtualItems().map((row) => (
          <div
            key={row.key}
            data-index={row.index}
            ref={listVirtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${row.start}px)`,
            }}
          >
            {renderSessionItem(filteredSessions[row.index])}
          </div>
        ))}
      </div>
    );
  };

  const renderMessages = () => {
    if (isLoadingMessages) {
      return (
        <div className="session-pane-status" role="status">
          <RefreshCw className="size-4 motion-safe:animate-spin" aria-hidden />
          正在读取对话…
        </div>
      );
    }
    if (isMessagesError && readFailure) {
      const detail = extractErrorMessage(messagesError);
      return (
        <div role="alert" className="session-state is-error">
          <AlertTriangle className="session-state-icon" aria-hidden />
          <h3>读取失败</h3>
          <p>{readFailure.hint || "无法读取这条会话的记录文件。"}</p>
          {detail ? (
            <details className="session-state-detail chimera-disclosure is-inline">
              <summary>错误详情</summary>
              <code>{detail}</code>
            </details>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={isFetchingMessages}
            onClick={() => void refetchMessages()}
          >
            <RefreshCw
              className={`size-3.5 mr-1.5${isFetchingMessages ? " motion-safe:animate-spin" : ""}`}
              aria-hidden
            />
            重试
          </Button>
        </div>
      );
    }
    if (messages.length === 0) {
      return (
        <div className="session-state">
          <MessageSquare className="session-state-icon" aria-hidden />
          <p>这条会话没有可以显示的对话。</p>
        </div>
      );
    }
    return (
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            <SessionMessageItem
              message={messages[virtualRow.index]}
              isActive={activeMessageIndex === virtualRow.index}
              searchQuery={search}
              onCopy={handleMessageCopy}
            />
          </div>
        ))}
      </div>
    );
  };

  return (
    <TooltipProvider>
      <div
        className="session-manager-page"
        onWheel={(e) => e.stopPropagation()}
      >
        <header className="session-page-heading">
          <div>
            <h1>会话记录</h1>
            <p>找回上下文，继续未完成的工作。</p>
          </div>
          <Select
            value={providerFilter}
            onValueChange={(value) =>
              setProviderFilter(value as ProviderFilter)
            }
          >
            <SelectTrigger className="session-app-select" aria-label="会话应用">
              <span className="session-app-label">应用</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                <div className="flex items-center gap-2">
                  <LayoutGrid className="size-3.5" aria-hidden />
                  <span>全部</span>
                </div>
              </SelectItem>
              {PROVIDER_FILTERS.map((providerId) => (
                <SelectItem key={providerId} value={providerId}>
                  <div className="flex items-center gap-2">
                    <ProviderIcon
                      icon={getProviderIconName(providerId)}
                      name={providerId}
                      size={14}
                    />
                    <span>{getProviderLabel(providerId)}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </header>
        <div className="session-page-body">
          {deleteRetryTargets.length > 0 && (
            <div role="alert" className="session-retry-banner">
              <AlertTriangle className="size-4 shrink-0" aria-hidden />
              <span className="session-retry-banner-text">
                {describeUnfinishedDeletes(deleteRetryTargets)}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={isDeleting}
                onClick={() => setDeleteTargets(deleteRetryTargets)}
              >
                重试未完成的删除
              </Button>
            </div>
          )}
          {isListError && sessions.length > 0 && (
            <div role="alert" className="session-retry-banner">
              <AlertTriangle className="size-4 shrink-0" aria-hidden />
              <span className="session-retry-banner-text">
                刷新会话列表失败，下面是上次读取的结果。
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={isFetchingList}
                onClick={() => void refetch()}
              >
                重试
              </Button>
            </div>
          )}
          {listUnavailable ? (
            <div role="alert" className="session-state is-error is-page">
              <AlertTriangle className="session-state-icon" aria-hidden />
              <h3>无法读取会话列表</h3>
              <p>
                读取本机会话记录时出错。请确认相关工具的数据文件夹可以访问，然后重试。
              </p>
              {extractErrorMessage(listError) ? (
                <details className="session-state-detail chimera-disclosure is-inline">
                  <summary>错误详情</summary>
                  <code>{extractErrorMessage(listError)}</code>
                </details>
              ) : null}
              <Button
                size="sm"
                disabled={isFetchingList}
                onClick={() => void refetch()}
              >
                <RefreshCw
                  className={`size-3.5 mr-1.5${isFetchingList ? " motion-safe:animate-spin" : ""}`}
                  aria-hidden
                />
                重试
              </Button>
            </div>
          ) : noSessionsAtAll ? (
            <div className="session-state is-page">
              <MessageSquare className="session-state-icon" aria-hidden />
              <h3>还没有会话记录</h3>
              <p>
                在 Codex
                或其他已接入的工具里开始对话后，会话会出现在这里，可以随时回看和继续。
              </p>
              <div className="session-state-actions">
                <Button
                  size="sm"
                  disabled={isFetchingList}
                  onClick={() => void refetch()}
                >
                  <RefreshCw className="size-3.5 mr-1.5" aria-hidden />
                  刷新列表
                </Button>
                {codexRelevant ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={isReclaiming}
                    onClick={() => setReclaimConfirmOpen(true)}
                  >
                    <ArchiveRestore className="size-3.5 mr-1.5" aria-hidden />
                    恢复其他线路下的会话
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="session-workspace">
              {/* 左侧会话列表 */}
              <Card className="session-list-panel flex flex-col min-h-0 overflow-hidden">
                <CardHeader className="session-list-head p-3 space-y-0 border-b shrink-0">
                  <div className="session-list-header">
                    <div className="flex items-center gap-2 min-w-0">
                      <CardTitle className="text-sm font-semibold whitespace-nowrap">
                        会话
                      </CardTitle>
                      <Badge variant="secondary" className="text-xs">
                        {filteredSessions.length}
                      </Badge>
                    </div>
                    <div className="session-list-toolbar">
                      {(selectionMode ||
                        deletableFilteredSessions.length > 0) && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant={selectionMode ? "secondary" : "ghost"}
                              size="icon"
                              className={
                                selectionMode
                                  ? "size-7 bg-muted text-foreground hover:bg-accent"
                                  : "size-7"
                              }
                              aria-label={
                                selectionMode
                                  ? t("sessionManager.exitBatchModeTooltip", {
                                      defaultValue: "退出批量管理",
                                    })
                                  : t("sessionManager.manageBatchTooltip", {
                                      defaultValue: "批量管理",
                                    })
                              }
                              onClick={() => {
                                if (selectionMode) {
                                  exitSelectionMode();
                                } else {
                                  setSelectionMode(true);
                                }
                              }}
                            >
                              <CheckSquare className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {selectionMode
                              ? t("sessionManager.exitBatchModeTooltip", {
                                  defaultValue: "退出批量管理",
                                })
                              : t("sessionManager.manageBatchTooltip", {
                                  defaultValue: "批量管理",
                                })}
                          </TooltipContent>
                        </Tooltip>
                      )}
                      <Select
                        value={listViewMode}
                        onValueChange={(value) =>
                          setListViewMode(value as SessionListViewMode)
                        }
                      >
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <SelectTrigger
                              className="size-7 p-0 justify-center border-0 bg-transparent hover:bg-muted"
                              aria-label={t("sessionManager.viewModeTooltip", {
                                defaultValue: "查看方式",
                              })}
                            >
                              <span className="sr-only">
                                {t("sessionManager.viewModeTooltip", {
                                  defaultValue: "查看方式",
                                })}
                              </span>
                              {listViewMode === "grouped" ? (
                                <ListTree className="size-3.5" />
                              ) : (
                                <List className="size-3.5" />
                              )}
                            </SelectTrigger>
                          </TooltipTrigger>
                          <TooltipContent>
                            查看方式：{listViewModeLabel}
                          </TooltipContent>
                        </Tooltip>
                        <SelectContent className="w-40">
                          <SelectItem value="flat">
                            <div className="flex items-center gap-2">
                              <List className="size-3.5" />
                              <span>
                                {t("sessionManager.viewModeFlat", {
                                  defaultValue: "列表",
                                })}
                              </span>
                            </div>
                          </SelectItem>
                          <SelectItem value="grouped">
                            <div className="flex items-center gap-2">
                              <ListTree className="size-3.5" />
                              <span>按文件夹分类</span>
                            </div>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      {listViewMode === "grouped" && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              aria-label={t(
                                "sessionManager.collapseAllGroups",
                                {
                                  defaultValue: "全部收起",
                                },
                              )}
                              onClick={handleCollapseAllGroups}
                            >
                              <ChevronsDownUp className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {t("sessionManager.collapseAllGroups", {
                              defaultValue: "全部收起",
                            })}
                          </TooltipContent>
                        </Tooltip>
                      )}
                      {codexRelevant && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              onClick={() => setReclaimConfirmOpen(true)}
                              disabled={isReclaiming}
                              aria-label={t("sessionManager.reclaimHistory", {
                                defaultValue: "一键恢复所有历史会话",
                              })}
                            >
                              <ArchiveRestore
                                className={`size-3.5${isReclaiming ? " motion-safe:animate-pulse" : ""}`}
                              />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            恢复其他线路下的 Codex
                            会话（切换线路后会话不见时使用）
                          </TooltipContent>
                        </Tooltip>
                      )}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            aria-label={t("common.refresh", {
                              defaultValue: "刷新",
                            })}
                            onClick={() => {
                              void refetch();
                              if (selectedSession) void refetchMessages();
                            }}
                          >
                            <RefreshCw
                              className={`size-3.5${isFetchingList ? " motion-safe:animate-spin" : ""}`}
                            />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>刷新列表</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                  <div className="session-search">
                    <Search
                      className="session-search-icon size-3.5"
                      aria-hidden
                    />
                    <Input
                      ref={searchInputRef}
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="搜索标题、文件夹或 ID"
                      aria-label={t("sessionManager.searchSessions", {
                        defaultValue: "搜索会话",
                      })}
                      className="h-8 pl-8 pr-8 text-sm"
                      onKeyDown={(event) => {
                        if (event.key === "Escape" && search) {
                          event.stopPropagation();
                          setSearch("");
                        }
                      }}
                    />
                    {search ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="session-search-clear size-6"
                        aria-label="清除搜索"
                        onClick={clearSearch}
                      >
                        <X className="size-3" />
                      </Button>
                    ) : null}
                  </div>
                  {selectionMode && (
                    <div className="session-batch-panel">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Badge variant="outline" className="text-xs">
                          {t("sessionManager.selectedCount", {
                            defaultValue: "已选 {{count}} 项",
                            count: selectedDeletableSessions.length,
                          })}
                        </Badge>
                        <span className="truncate">
                          {t("sessionManager.batchModeHint", {
                            defaultValue: "勾选要删除的会话",
                          })}
                        </span>
                      </div>
                      <div className="session-batch-actions">
                        <div className="flex flex-wrap items-center gap-2">
                          {deletableFilteredSessions.length > 0 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2.5 text-xs whitespace-nowrap"
                              onClick={handleToggleSelectAll}
                            >
                              {allFilteredSelected
                                ? t("sessionManager.clearFilteredSelection", {
                                    defaultValue: "取消全选",
                                  })
                                : t("sessionManager.selectAllFiltered", {
                                    defaultValue: "全选当前",
                                  })}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2.5 text-xs whitespace-nowrap"
                            onClick={() => setSelectedSessionKeys(new Set())}
                          >
                            {t("sessionManager.clearSelection", {
                              defaultValue: "清空已选",
                            })}
                          </Button>
                        </div>
                        <Button
                          variant="destructive"
                          size="sm"
                          className="h-7 gap-1.5 px-2.5 whitespace-nowrap"
                          onClick={() =>
                            requestDelete(selectedDeletableSessions)
                          }
                          disabled={
                            isDeleting || selectedDeletableSessions.length === 0
                          }
                        >
                          <Trash2 className="size-3.5" />
                          <span className="text-xs">
                            {isDeleting
                              ? "删除中…"
                              : t("sessionManager.deleteSelected", {
                                  defaultValue: "批量删除",
                                })}
                          </span>
                        </Button>
                      </div>
                    </div>
                  )}
                </CardHeader>
                <CardContent className="flex-1 min-h-0 p-0">
                  <div ref={listScrollRef} className="session-list-scroll">
                    {renderListBody()}
                  </div>
                </CardContent>
              </Card>

              {/* 右侧会话详情 */}
              <Card className="session-detail-panel flex flex-col overflow-hidden min-h-0 min-w-0">
                {!selectedSession ? (
                  <div className="session-state">
                    <MessageSquare className="session-state-icon" aria-hidden />
                    <p>
                      {isLoading
                        ? "正在读取会话列表…"
                        : filteredSessions.length > 0
                          ? "从左侧选择一条会话，查看完整对话。"
                          : "没有可以显示的会话。"}
                    </p>
                  </div>
                ) : (
                  <>
                    {/* 详情头部 */}
                    <CardHeader className="session-detail-head px-4 py-3 space-y-0 border-b shrink-0">
                      <div className="session-detail-title-row">
                        <span
                          className="shrink-0"
                          title={getProviderLabel(selectedSession.providerId)}
                        >
                          <ProviderIcon
                            icon={getProviderIconName(
                              selectedSession.providerId,
                            )}
                            name={selectedSession.providerId}
                            size={20}
                          />
                        </span>
                        <h2
                          className="session-detail-title"
                          title={selectedTitle}
                        >
                          {selectedTitle}
                        </h2>
                        {isArchivedSession(selectedSession) ? (
                          <span className="session-tag">已归档</span>
                        ) : null}
                        <div className="session-detail-actions">
                          {isMac() && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="sm"
                                  className="gap-1.5"
                                  onClick={() => void handleResume()}
                                  disabled={!selectedSession.resumeCommand}
                                >
                                  <Play className="size-3.5" />
                                  <span className="hidden sm:inline">
                                    {t("sessionManager.resume", {
                                      defaultValue: "恢复会话",
                                    })}
                                  </span>
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                {selectedSession.resumeCommand
                                  ? t("sessionManager.resumeTooltip", {
                                      defaultValue: "在终端中恢复此会话",
                                    })
                                  : t("sessionManager.noResumeCommand", {
                                      defaultValue: "此会话无法恢复",
                                    })}
                              </TooltipContent>
                            </Tooltip>
                          )}
                          <SessionExportButton
                            session={selectedSession}
                            messages={messages}
                            unavailableReason={exportUnavailableReason}
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            className="gap-1.5 text-muted-foreground"
                            onClick={() => requestDelete([selectedSession])}
                            disabled={!selectedSession.sourcePath || isDeleting}
                          >
                            <Trash2 className="size-3.5" aria-hidden />
                            {isDeleting
                              ? "删除中…"
                              : t("sessionManager.delete", {
                                  defaultValue: "删除会话",
                                })}
                          </Button>
                        </div>
                      </div>

                      {/* 元信息 */}
                      <div className="session-detail-meta">
                        <span
                          className="session-detail-meta-item"
                          title="最近活动时间"
                        >
                          <Clock className="size-3 shrink-0" aria-hidden />
                          <span>
                            {formatTimestamp(
                              selectedSession.lastActiveAt ??
                                selectedSession.createdAt,
                            ) || "时间未知"}
                          </span>
                        </span>
                        {selectedSession.projectDir && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={() =>
                                  void handleCopy(
                                    selectedSession.projectDir!,
                                    t("sessionManager.projectDirCopied"),
                                  )
                                }
                                className="session-detail-meta-item is-button"
                              >
                                <FolderOpen
                                  className="size-3 shrink-0"
                                  aria-hidden
                                />
                                <span className="truncate">
                                  {getBaseName(selectedSession.projectDir)}
                                </span>
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" className="max-w-xs">
                              <p className="font-mono text-xs break-all">
                                {selectedSession.projectDir}
                              </p>
                              <p className="text-muted-foreground mt-1">
                                点击复制文件夹路径
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        )}
                        {selectedSession.sourcePath && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={() =>
                                  void handleCopy(
                                    selectedSession.sourcePath!,
                                    t("sessionManager.sourcePathCopied"),
                                  )
                                }
                                className="session-detail-meta-item is-button"
                              >
                                <FileText
                                  className="size-3 shrink-0"
                                  aria-hidden
                                />
                                <span className="font-mono truncate">
                                  {getBaseName(selectedSession.sourcePath)}
                                </span>
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" className="max-w-xs">
                              <p className="font-mono text-xs break-all">
                                {selectedSession.sourcePath}
                              </p>
                              <p className="text-muted-foreground mt-1">
                                点击复制记录文件路径
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>

                      {/* 恢复命令预览 */}
                      {selectedSession.resumeCommand && (
                        <div className="session-resume-row">
                          <code className="session-resume-command">
                            {selectedSession.resumeCommand}
                          </code>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7 shrink-0"
                                aria-label={t("sessionManager.copyCommand", {
                                  defaultValue: "复制命令",
                                })}
                                onClick={() =>
                                  void handleCopy(
                                    selectedSession.resumeCommand!,
                                    t("sessionManager.resumeCommandCopied"),
                                  )
                                }
                              >
                                <Copy className="size-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>复制继续对话的命令</TooltipContent>
                          </Tooltip>
                        </div>
                      )}
                    </CardHeader>

                    {/* 消息列表区域 */}
                    <CardContent className="flex-1 min-h-0 p-0">
                      <div className="flex h-full min-w-0">
                        {/* 消息列表 */}
                        <div className="flex-1 min-w-0 flex flex-col">
                          <div className="session-conversation-head">
                            <MessageSquare
                              className="size-4 text-muted-foreground"
                              aria-hidden
                            />
                            <span className="text-sm font-medium">
                              对话记录
                            </span>
                            {/* A count is only true once the messages are in. */}
                            {!isLoadingMessages && !isMessagesError ? (
                              <Badge variant="secondary" className="text-xs">
                                {
                                  messages.filter(
                                    (message) => !isNoticeMessage(message),
                                  ).length
                                }
                              </Badge>
                            ) : null}
                            <span className="flex-1" />
                            <SessionTocDialog
                              items={userMessagesToc}
                              onItemClick={scrollToMessage}
                              open={tocDialogOpen}
                              onOpenChange={setTocDialogOpen}
                            />
                          </div>
                          {contentTruncated &&
                            !isLoadingMessages &&
                            !isMessagesError && (
                              <div
                                className="session-truncated-banner"
                                role="status"
                              >
                                <Info
                                  className="size-3.5 shrink-0 mt-0.5"
                                  aria-hidden
                                />
                                <span>
                                  <strong>内容过大，已截断显示。</strong>
                                  过长的记录和工具输出只显示了一部分，记录文件本身没有改动。
                                </span>
                              </div>
                            )}
                          <div
                            ref={scrollContainerRef}
                            className="flex-1 overflow-y-auto px-4 pb-4 min-w-0"
                          >
                            {renderMessages()}
                          </div>
                        </div>

                        {/* 右侧目录 - 类似少数派 (大屏幕) */}
                        <SessionTocSidebar
                          items={userMessagesToc}
                          onItemClick={scrollToMessage}
                        />
                      </div>
                    </CardContent>
                  </>
                )}
              </Card>
            </div>
          )}
        </div>
      </div>
      <ConfirmDialog
        isOpen={reclaimConfirmOpen}
        variant="info"
        title={t("sessionManager.reclaimConfirmTitle", {
          defaultValue: "恢复所有历史会话",
        })}
        message={t("sessionManager.reclaimConfirmMessage", {
          defaultValue:
            "会把此前在其他中转线路下产生的 Codex 历史会话，统一归入当前线路的会话分组，使它们重新出现在列表中。\n\n启动、切换线路和刷新列表时已会自动执行，这里用于手动重试。\n\n只改写本机会话记录的分组标识，不修改会话内容；改写前会自动备份，可重复执行。",
        })}
        confirmText={t("sessionManager.reclaimConfirmAction", {
          defaultValue: "开始恢复",
        })}
        onConfirm={() => void handleReclaimHistory()}
        onCancel={() => setReclaimConfirmOpen(false)}
      />
      <SessionDeleteDialog
        targets={deleteTargets}
        onConfirm={() => void handleDeleteConfirm()}
        onCancel={() => {
          if (!isDeleting) {
            setDeleteTargets(null);
          }
        }}
      />
    </TooltipProvider>
  );
}
