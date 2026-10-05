import { Fragment, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import type {
  ConversationProviderUsage,
  ConversationUsage,
  ConversationUsageReport,
} from "@/types/usage";
import {
  formatUsageDateTime,
  formatUsageRelativeTime,
  formatUsageTokens,
} from "@/utils/usageMetrics";

/** Rows listed before "显示全部"; the backend already caps the report at 200. */
export const CONVERSATION_PREVIEW_ROWS = 10;
/** Requests found only in session files; they do not record a line. */
const SESSION_PROVIDER_ID = "_codex_session";
const SKELETON_ROWS = [0, 1, 2];

interface ConversationUsageSectionProps {
  /** `null` until the first report arrives. */
  report: ConversationUsageReport | null;
  loading: boolean;
  query: string;
  onQueryChange: (query: string) => void;
}

export function ConversationUsageSection({
  report,
  loading,
  query,
  onQueryChange,
}: ConversationUsageSectionProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [showAll, setShowAll] = useState(false);
  const rows = report?.conversations ?? [];
  const visible = showAll ? rows : rows.slice(0, CONVERSATION_PREVIEW_ROWS);
  const searching = query.trim() !== "";

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <section
      className="usage-summary-section usage-conversations"
      aria-labelledby="usage-conversations-title"
    >
      <header>
        <div>
          <h2 id="usage-conversations-title">按对话汇总</h2>
          <span>子代理和分叉的用量已计入发起它的对话</span>
        </div>
        <div className="usage-conversation-tools">
          <label className="usage-conversation-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={query}
              placeholder="搜索对话标题"
              aria-label="搜索对话标题"
              onChange={(event) => onQueryChange(event.target.value)}
            />
          </label>
          {report && (
            <span>
              {searching
                ? `找到 ${report.matchedConversations.toLocaleString("zh-CN")} 个`
                : `共 ${report.totalConversations.toLocaleString("zh-CN")} 个对话`}
            </span>
          )}
        </div>
      </header>

      {report && report.matchedConversations === 0 ? (
        <div className="usage-conversation-status" role="status">
          {searching ? (
            <>
              <span>没有标题包含“{query.trim()}”的对话</span>
              <button type="button" onClick={() => onQueryChange("")}>
                清除搜索
              </button>
            </>
          ) : (
            <span>这段时间的用量没有对应到具体对话</span>
          )}
        </div>
      ) : (
        <table
          className={`usage-conversation-table${loading ? " is-refreshing" : ""}`}
          aria-busy={loading}
        >
          <colgroup>
            <col />
            <col className="usage-col-time" />
            <col className="usage-col-count" />
            <col className="usage-col-tokens" />
            <col className="usage-col-count" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">对话</th>
              <th scope="col">最近活动</th>
              <th scope="col">请求</th>
              <th scope="col">词元</th>
              <th scope="col">子代理</th>
            </tr>
          </thead>
          <tbody>
            {!report &&
              SKELETON_ROWS.map((row) => (
                <tr
                  className="usage-conversation-skeleton"
                  key={row}
                  aria-hidden="true"
                >
                  <td colSpan={5}>
                    <span />
                  </td>
                </tr>
              ))}
            {visible.map((conversation, index) => {
              const open = expanded.has(conversation.id);
              const detailId = `usage-conversation-${conversation.id}`;
              return (
                <Fragment key={conversation.id}>
                  <tr
                    className={`usage-conversation-row${index % 2 ? "" : " is-striped"}`}
                  >
                    <td>
                      <button
                        type="button"
                        className="usage-conversation-toggle"
                        aria-expanded={open}
                        aria-controls={detailId}
                        onClick={() => toggle(conversation.id)}
                      >
                        <ChevronRight size={14} aria-hidden="true" />
                        <span
                          className={conversation.title ? "" : "is-untitled"}
                          title={conversation.title ?? undefined}
                        >
                          {conversation.title ?? "未命名对话"}
                        </span>
                      </button>
                    </td>
                    <td>
                      <time
                        dateTime={new Date(
                          conversation.lastActivityAt * 1000,
                        ).toISOString()}
                        title={formatUsageDateTime(conversation.lastActivityAt)}
                      >
                        {formatUsageRelativeTime(conversation.lastActivityAt)}
                      </time>
                    </td>
                    <td>{conversation.requestCount.toLocaleString("zh-CN")}</td>
                    <td
                      title={`${conversation.totalTokens.toLocaleString("zh-CN")} 词元，含缓存`}
                    >
                      <b>{formatUsageTokens(conversation.totalTokens)}</b>
                    </td>
                    <td className={conversation.subagentCount ? "" : "is-zero"}>
                      {conversation.subagentCount}
                    </td>
                  </tr>
                  {open && (
                    <tr id={detailId} className="usage-conversation-detail">
                      <td colSpan={5}>
                        <ConversationDetail conversation={conversation} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}

      {report && (
        <ConversationFooter
          report={report}
          listed={rows.length}
          showAll={showAll}
          onToggleAll={() => setShowAll((value) => !value)}
        />
      )}
    </section>
  );
}

function ConversationFooter({
  report,
  listed,
  showAll,
  onToggleAll,
}: {
  report: ConversationUsageReport;
  listed: number;
  showAll: boolean;
  onToggleAll: () => void;
}) {
  const expandable = listed > CONVERSATION_PREVIEW_ROWS;
  const truncated = report.matchedConversations > listed;
  const unattributed = report.unattributedTokens > 0;
  if (!expandable && !truncated && !unattributed) return null;
  return (
    <footer className="usage-conversation-footer">
      {expandable && (
        <button
          type="button"
          className="usage-view-all"
          aria-expanded={showAll}
          onClick={onToggleAll}
        >
          {showAll ? "收起" : `显示全部 ${listed} 个`}
        </button>
      )}
      {truncated && <span>只列出最近活动的 {listed} 个对话</span>}
      {unattributed && (
        <span>
          另有 {formatUsageTokens(report.unattributedTokens)}{" "}
          词元无法归入具体对话，已计入上方总量
        </span>
      )}
    </footer>
  );
}

function ConversationDetail({
  conversation,
}: {
  conversation: ConversationUsage;
}) {
  const cache = conversation.cacheCreationTokens + conversation.cacheReadTokens;
  const lines = conversation.providers.some(
    (provider) => provider.providerId !== SESSION_PROVIDER_ID,
  );
  const first = formatUsageDateTime(conversation.firstActivityAt);
  const last = formatUsageDateTime(conversation.lastActivityAt);
  return (
    <div className="usage-conversation-facts">
      <dl>
        <div>
          <dt>词元构成</dt>
          <dd>
            输入 {formatUsageTokens(conversation.inputTokens)} · 输出{" "}
            {formatUsageTokens(conversation.outputTokens)} · 缓存{" "}
            {formatUsageTokens(cache)}
          </dd>
        </div>
        <div>
          <dt>缓存命中</dt>
          <dd>{(conversation.cacheHitRate * 100).toFixed(0)}%</dd>
        </div>
        <div>
          <dt>估算成本</dt>
          <dd>{costLabel(conversation)}</dd>
        </div>
        <div>
          <dt>时间</dt>
          <dd>{first === last ? first : `${first} 至 ${last}`}</dd>
        </div>
        {lines && (
          <div>
            <dt>线路</dt>
            <dd className="usage-provider-list">
              {conversation.providers.map((provider) => (
                <span key={provider.providerId}>
                  {providerLabel(provider)} · {provider.requestCount} 次 ·{" "}
                  {formatUsageTokens(provider.totalTokens)}
                </span>
              ))}
            </dd>
          </div>
        )}
      </dl>
      {conversation.subagents.length > 0 && (
        <ul className="usage-conversation-children" aria-label="已计入的子代理">
          {conversation.subagents.map((child) => (
            <li key={child.id}>
              <span className="usage-child-kind">
                {child.isFork ? "分叉" : "子代理"}
              </span>
              <span
                className="usage-child-title"
                title={child.title ?? undefined}
              >
                {child.title ?? "未命名"}
              </span>
              <span>{child.requestCount} 次</span>
              <b>{formatUsageTokens(child.totalTokens)}</b>
            </li>
          ))}
        </ul>
      )}
      {conversation.subagentCount > conversation.subagents.length && (
        <p className="usage-conversation-more">
          另有 {conversation.subagentCount - conversation.subagents.length}{" "}
          个子代理未列出，用量已计入
        </p>
      )}
    </div>
  );
}

function providerLabel(provider: ConversationProviderUsage): string {
  return provider.providerId === SESSION_PROVIDER_ID
    ? "未记录线路"
    : provider.providerName;
}

/** Stored estimates only; never present an unpriced conversation as free. */
export function costLabel(conversation: ConversationUsage): string {
  const cost = Number.parseFloat(conversation.totalCost);
  const unpriced = conversation.unpricedRequestCount;
  if (!Number.isFinite(cost) || cost <= 0) return unpriced ? "未计价" : "$0";
  const amount = cost < 0.01 ? "< $0.01" : `$${cost.toFixed(2)}`;
  return unpriced ? `${amount}，另有 ${unpriced} 次请求未计价` : amount;
}
