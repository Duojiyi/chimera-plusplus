import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { ProviderIcon } from "@/components/ProviderIcon";
import type { SessionMeta } from "@/types";
import {
  formatRelativeTime,
  formatSessionTitle,
  formatTimestamp,
  getBaseName,
  getProviderIconName,
  getProviderLabel,
  getSessionKey,
  highlightText,
  isArchivedSession,
} from "./utils";

interface SessionItemProps {
  session: SessionMeta;
  isSelected: boolean;
  selectionMode: boolean;
  isChecked: boolean;
  isCheckDisabled?: boolean;
  /** The folder is already named by the group the row sits in. */
  showFolder?: boolean;
  searchQuery?: string;
  onSelect: (key: string) => void;
  onToggleChecked: (checked: boolean) => void;
}

export function SessionItem({
  session,
  isSelected,
  selectionMode,
  isChecked,
  isCheckDisabled = false,
  showFolder = true,
  searchQuery,
  onSelect,
  onToggleChecked,
}: SessionItemProps) {
  const { t } = useTranslation();
  const title = formatSessionTitle(session);
  const lastActive = session.lastActiveAt || session.createdAt || undefined;
  const sessionKey = getSessionKey(session);
  const folder = showFolder ? getBaseName(session.projectDir) : "";
  const archived = isArchivedSession(session);

  return (
    <div className={cn("session-list-row", isSelected && "is-selected")}>
      {selectionMode && (
        <div className="session-list-row-check">
          <Checkbox
            checked={isChecked}
            disabled={isCheckDisabled}
            aria-label={t("sessionManager.selectForBatch", {
              defaultValue: "选择会话",
            })}
            onCheckedChange={(checked) => onToggleChecked(Boolean(checked))}
          />
        </div>
      )}
      <button
        type="button"
        onClick={() => onSelect(sessionKey)}
        aria-pressed={isSelected}
        className="session-list-row-main"
      >
        <span className="session-list-row-title">
          <span
            className="session-list-row-icon"
            title={getProviderLabel(session.providerId)}
          >
            <ProviderIcon
              icon={getProviderIconName(session.providerId)}
              name={session.providerId}
              size={16}
            />
          </span>
          <span className="session-list-row-text" title={title}>
            {searchQuery ? highlightText(title, searchQuery) : title}
          </span>
        </span>
        <span className="session-list-row-meta">
          <span title={lastActive ? formatTimestamp(lastActive) : undefined}>
            {lastActive
              ? formatRelativeTime(lastActive, t)
              : t("common.unknown", { defaultValue: "时间未知" })}
          </span>
          {folder ? (
            <span
              className="session-list-row-folder"
              title={session.projectDir ?? undefined}
            >
              {folder}
            </span>
          ) : null}
          {archived ? <span className="session-tag">已归档</span> : null}
        </span>
      </button>
    </div>
  );
}
