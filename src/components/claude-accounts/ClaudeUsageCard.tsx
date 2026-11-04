import "./ClaudeAccountsCard.css";
import "./ClaudeUsageCard.css";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChartColumn, ChevronDown, Loader2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  claudeAccountsApi,
  type ClaudeUsageBucket,
  type ClaudeUsageDay,
  type ClaudeUsageNamed,
  type ClaudeUsageOverview,
} from "@/lib/api/claudeAccounts";
import { errorText } from "./quota";
import { useStoredFlag } from "./useStoredFlag";

const RANGES: { days: number | null; label: string }[] = [
  { days: 7, label: "7 天" },
  { days: 30, label: "30 天" },
  { days: 90, label: "90 天" },
  { days: null, label: "全部" },
];

const MAX_HEATMAP_WEEKS = 53;
const DAY_MS = 86_400_000;

/** 1,234 → "1.2K", 3_400_000 → "3.4M". */
export function compact(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, unit] of units) {
    if (value >= size) {
      const scaled = value / size;
      return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, "")}${unit}`;
    }
  }
  return String(value);
}

export function bucketTokens(bucket: ClaudeUsageBucket): number {
  const { input, output, cacheRead, cacheWrite } = bucket.tokens;
  return input + output + cacheRead + cacheWrite;
}

export function money(bucket: ClaudeUsageBucket): string {
  if (bucket.costUsd === 0 && bucket.costPartial) return "—";
  const text =
    bucket.costUsd >= 100
      ? bucket.costUsd.toFixed(0)
      : bucket.costUsd >= 1
        ? bucket.costUsd.toFixed(2)
        : bucket.costUsd.toFixed(3);
  return `${bucket.costPartial ? "≥ " : ""}$${text}`;
}

const pad = (value: number) => String(value).padStart(2, "0");
const dayKey = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export interface HeatCell {
  day: string;
  tokens: number;
  /** The day is inside the chosen range and not in the future. */
  inRange: boolean;
  level: 0 | 1 | 2 | 3 | 4;
}

/**
 * Weeks as columns (Monday first) ending with the week that holds `today`.
 * Days outside `rangeDays` stay in the grid, empty, so the shape is stable.
 */
export function heatmapWeeks(
  days: ClaudeUsageDay[],
  rangeDays: number | null,
  today: Date,
): HeatCell[][] {
  const byDay = new Map(days.map((d) => [d.day, bucketTokens(d)]));
  const max = Math.max(0, ...byDay.values());
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let spanDays: number;
  if (rangeDays !== null) {
    spanDays = rangeDays;
  } else {
    const first = days[0]?.day;
    const firstDate = first
      ? new Date(`${first}T00:00:00`)
      : new Date(end.getTime() - 29 * DAY_MS);
    spanDays = Math.round((end.getTime() - firstDate.getTime()) / DAY_MS) + 1;
  }
  const start = new Date(end.getTime() - (Math.max(1, spanDays) - 1) * DAY_MS);
  // Back to the Monday of the first week, forward to the Sunday of the last.
  const mondayOffset = (start.getDay() + 6) % 7;
  const gridStart = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate() - mondayOffset,
  );
  const sundayOffset = 6 - ((end.getDay() + 6) % 7);
  const gridEnd = new Date(
    end.getFullYear(),
    end.getMonth(),
    end.getDate() + sundayOffset,
  );
  // Monday to Sunday inclusive is whole weeks.
  let weeks = Math.round(
    ((gridEnd.getTime() - gridStart.getTime()) / DAY_MS + 1) / 7,
  );
  weeks = Math.min(Math.max(weeks, 1), MAX_HEATMAP_WEEKS);
  const firstColumn = new Date(
    gridEnd.getFullYear(),
    gridEnd.getMonth(),
    gridEnd.getDate() - weeks * 7 + 1,
  );
  const columns: HeatCell[][] = [];
  for (let w = 0; w < weeks; w++) {
    const column: HeatCell[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(
        firstColumn.getFullYear(),
        firstColumn.getMonth(),
        firstColumn.getDate() + w * 7 + d,
      );
      const key = dayKey(date);
      const inRange = date >= start && date <= end;
      const tokens = inRange ? (byDay.get(key) ?? 0) : 0;
      const level =
        tokens === 0 || max === 0
          ? 0
          : (Math.min(
              4,
              Math.max(1, Math.ceil(4 * Math.sqrt(tokens / max))),
            ) as 1 | 2 | 3 | 4);
      column.push({ day: key, tokens, inRange, level });
    }
    columns.push(column);
  }
  return columns;
}

export interface UsageFacts {
  activeDays: number;
  /** Tokens per active day. */
  perActiveDay: number;
  busiest?: ClaudeUsageDay;
  /** The most days in a row with use. */
  longestStreak: number;
}

/** What the days say about how steadily Claude Code is used. */
export function usageFacts(days: ClaudeUsageDay[]): UsageFacts {
  const used = days
    .filter((d) => bucketTokens(d) > 0)
    .sort((a, b) => a.day.localeCompare(b.day));
  let streak = 0;
  let longestStreak = 0;
  let previous: number | null = null;
  for (const entry of used) {
    const at = new Date(`${entry.day}T00:00:00`).getTime();
    streak =
      previous !== null && Math.round((at - previous) / DAY_MS) === 1
        ? streak + 1
        : 1;
    longestStreak = Math.max(longestStreak, streak);
    previous = at;
  }
  const total = used.reduce((sum, d) => sum + bucketTokens(d), 0);
  return {
    activeDays: used.length,
    perActiveDay: used.length ? total / used.length : 0,
    busiest: used.reduce<ClaudeUsageDay | undefined>(
      (best, d) => (!best || bucketTokens(d) > bucketTokens(best) ? d : best),
      undefined,
    ),
    longestStreak,
  };
}

/** `2026-11-04` → `11月4日`. */
export function dayLabel(day: string): string {
  const [, month, date] = day.split("-");
  return `${Number(month)}月${Number(date)}日`;
}

/** The last `count` days ending today, oldest first. */
export function lastDays(count: number, today: Date): string[] {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Array.from({ length: count }, (_, index) =>
    dayKey(
      new Date(
        end.getFullYear(),
        end.getMonth(),
        end.getDate() - (count - 1 - index),
      ),
    ),
  );
}

/** A month or less: one bar per day, so the shape fills the card. */
function DayBars({
  rangeDays,
  byDay,
}: {
  rangeDays: number;
  byDay: Map<string, ClaudeUsageDay>;
}) {
  const dates = useMemo(() => lastDays(rangeDays, new Date()), [rangeDays]);
  const max = Math.max(
    1,
    ...dates.map((d) => (byDay.get(d) ? bucketTokens(byDay.get(d)!) : 0)),
  );
  return (
    <div
      className="claude-usage-bars"
      role="img"
      aria-label={`最近 ${rangeDays} 天每天的用量`}
    >
      <div className="claude-usage-bars-plot">
        {dates.map((date) => {
          const usage = byDay.get(date);
          const tokens = usage ? bucketTokens(usage) : 0;
          return (
            <span
              key={date}
              className="claude-usage-bar"
              data-empty={tokens === 0 ? "true" : undefined}
              style={{
                height:
                  tokens === 0
                    ? undefined
                    : `${Math.max(6, (tokens / max) * 100)}%`,
              }}
              title={
                usage
                  ? `${dayLabel(date)} · ${compact(tokens)} tokens · ${money(usage)} · ${usage.messages} 条消息`
                  : `${dayLabel(date)} · 没有使用`
              }
            />
          );
        })}
      </div>
      <div className="claude-usage-bars-axis" aria-hidden="true">
        <span>{dayLabel(dates[0])}</span>
        <span>今天</span>
      </div>
    </div>
  );
}

function Facts({ days }: { days: ClaudeUsageDay[] }) {
  const facts = useMemo(() => usageFacts(days), [days]);
  return (
    <dl className="claude-usage-facts">
      <div>
        <dt>活跃天数</dt>
        <dd>{facts.activeDays} 天</dd>
      </div>
      <div>
        <dt>每个活跃日</dt>
        <dd>{compact(facts.perActiveDay)} tokens</dd>
      </div>
      <div>
        <dt>最长连续</dt>
        <dd>{facts.longestStreak} 天</dd>
      </div>
      {facts.busiest ? (
        <div>
          <dt>最忙的一天</dt>
          <dd>
            {dayLabel(facts.busiest.day)}
            <small>
              {compact(bucketTokens(facts.busiest))} · {money(facts.busiest)}
            </small>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

function Tile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="claude-usage-tile" title={hint}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Heatmap({
  days,
  rangeDays,
  byDay,
}: {
  days: ClaudeUsageDay[];
  rangeDays: number | null;
  byDay: Map<string, ClaudeUsageDay>;
}) {
  const weeks = useMemo(
    () => heatmapWeeks(days, rangeDays, new Date()),
    [days, rangeDays],
  );
  const active = days.filter((d) => bucketTokens(d) > 0).length;
  return (
    <div
      className="claude-usage-heatmap"
      role="img"
      aria-label={`每日用量热力图，共 ${active} 天有使用`}
    >
      <div className="claude-usage-heat-grid">
        {weeks.map((column, index) => (
          <div key={index} className="claude-usage-heat-col">
            {column.map((cell) => {
              const usage = byDay.get(cell.day);
              return (
                <span
                  key={cell.day}
                  className="claude-usage-heat-cell"
                  data-level={cell.inRange ? cell.level : undefined}
                  data-outside={cell.inRange ? undefined : "true"}
                  title={
                    cell.inRange
                      ? `${cell.day} · ${compact(cell.tokens)} tokens${
                          usage
                            ? ` · ${money(usage)} · ${usage.messages} 条消息`
                            : ""
                        }`
                      : undefined
                  }
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="claude-usage-heat-legend" aria-hidden="true">
        少
        {[0, 1, 2, 3, 4].map((level) => (
          <span
            key={level}
            className="claude-usage-heat-cell"
            data-level={level}
          />
        ))}
        多
      </div>
    </div>
  );
}

type Breakdown = "projects" | "models" | "sources";
const BREAKDOWNS: { id: Breakdown; label: string }[] = [
  { id: "projects", label: "项目" },
  { id: "models", label: "模型" },
  { id: "sources", label: "账号" },
];
const COLLAPSED_ROWS = 8;

function BreakdownList({
  rows,
  label,
  showDetail,
}: {
  rows: ClaudeUsageNamed[];
  label: string;
  /** Under each name: its folder (projects only). */
  showDetail: boolean;
}) {
  const [all, setAll] = useState(false);
  const max = Math.max(1, ...rows.map(bucketTokens));
  const shown = all ? rows : rows.slice(0, COLLAPSED_ROWS);
  if (rows.length === 0)
    return <p className="claude-accounts-empty">这段时间里没有记录。</p>;
  return (
    <>
      <ul className="claude-usage-rank" aria-label={label}>
        {shown.map((row) => {
          const tokens = bucketTokens(row);
          return (
            <li key={`${row.name}|${row.detail ?? ""}`}>
              <div className="claude-usage-rank-name">
                <strong>{row.name}</strong>
                {showDetail && row.detail && row.detail !== row.name ? (
                  <code title={row.detail}>{row.detail}</code>
                ) : null}
              </div>
              <div
                className="claude-usage-rank-bar"
                role="meter"
                aria-label={`${row.name} 的 token 占比`}
                aria-valuemin={0}
                aria-valuemax={max}
                aria-valuenow={tokens}
              >
                <span style={{ width: `${(tokens / max) * 100}%` }} />
              </div>
              <span className="claude-usage-rank-num">
                {compact(tokens)}
                <small>{money(row)}</small>
              </span>
            </li>
          );
        })}
      </ul>
      {rows.length > COLLAPSED_ROWS ? (
        <button
          type="button"
          className="claude-usage-more"
          onClick={() => setAll((value) => !value)}
        >
          {all ? "收起" : `显示全部 ${rows.length} 项`}
        </button>
      ) : null}
    </>
  );
}

export interface ClaudeUsageCardProps {
  /** Running inside the desktop shell (native commands available). */
  native?: boolean;
  /** Open when the user has not chosen yet; counting waits for it. */
  defaultOpen?: boolean;
}

/** What Claude Code has used, from its own logs: totals, calendar, breakdowns. */
export function ClaudeUsageCard({
  native = true,
  defaultOpen = false,
}: ClaudeUsageCardProps) {
  const headingId = useId();
  const [open, setOpen] = useStoredFlag(
    "chimera.claude.usage.open",
    defaultOpen,
  );
  const [rangeDays, setRangeDays] = useState<number | null>(30);
  const [overview, setOverview] = useState<ClaudeUsageOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Breakdown>("projects");
  const request = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    async (days: number | null) => {
      if (!native) return;
      const mine = ++request.current;
      setLoading(true);
      setError(null);
      try {
        const result = await claudeAccountsApi.usageOverview(days);
        if (!result || !Array.isArray(result.days) || !result.totals)
          throw new Error("统计结果的格式不对");
        if (mounted.current && mine === request.current) setOverview(result);
      } catch (cause) {
        if (mounted.current && mine === request.current)
          setError(errorText(cause));
      } finally {
        if (mounted.current && mine === request.current) setLoading(false);
      }
    },
    [native],
  );

  // Counting reads every conversation log, so it waits until the card is opened.
  useEffect(() => {
    if (open) void load(rangeDays);
  }, [load, rangeDays, open]);

  const byDay = useMemo(
    () => new Map((overview?.days ?? []).map((d) => [d.day, d])),
    [overview],
  );
  const totals = overview?.totals;
  const rows = overview
    ? tab === "projects"
      ? overview.projects
      : tab === "models"
        ? overview.models
        : overview.sources
    : [];

  return (
    <section
      className="claude-accounts-card claude-usage-card"
      aria-labelledby={headingId}
    >
      <header className="claude-accounts-heading">
        <span className="claude-accounts-icon" aria-hidden="true">
          <ChartColumn size={18} />
        </span>
        <div className="claude-accounts-title">
          <h2 id={headingId}>用量总览</h2>
          <p>
            读取 Claude Code
            的会话日志统计，包括各个并行账号。费用按模型定价估算，和账单会有出入。
          </p>
        </div>
        {native && open ? (
          <div className="claude-usage-controls">
            <div
              className="claude-usage-range"
              role="radiogroup"
              aria-label="时间范围"
            >
              {RANGES.map((range) => (
                <button
                  key={range.label}
                  type="button"
                  role="radio"
                  aria-checked={rangeDays === range.days}
                  onClick={() => setRangeDays(range.days)}
                >
                  {range.label}
                </button>
              ))}
            </div>
            <Button
              size="icon"
              variant="ghost"
              disabled={loading}
              aria-label="重新统计"
              title="重新统计"
              onClick={() => void load(rangeDays)}
            >
              <RotateCw
                size={14}
                className={loading ? "animate-spin" : undefined}
                aria-hidden="true"
              />
            </Button>
          </div>
        ) : null}
        <button
          type="button"
          className="claude-card-toggle"
          aria-expanded={open}
          title={open ? "收起" : "展开"}
          onClick={() => setOpen(!open)}
        >
          <ChevronDown size={16} aria-hidden="true" />
          <span className="sr-only">{open ? "收起" : "展开"}用量总览</span>
        </button>
      </header>

      {!native ? (
        <p className="claude-accounts-note">用量总览需要在桌面端使用。</p>
      ) : !open ? null : error ? (
        <div className="claude-accounts-error" role="alert">
          <span>统计失败：{error}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void load(rangeDays)}
          >
            重试
          </Button>
        </div>
      ) : overview === null ? (
        <p className="claude-accounts-note" role="status">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          正在统计…第一次要读完所有会话日志，可能要几十秒。
        </p>
      ) : (
        <div className="claude-usage-body" data-stale={loading || undefined}>
          {totals && totals.messages === 0 ? (
            <p className="claude-accounts-empty">
              {rangeDays === null
                ? "还没有找到 Claude Code 的会话记录。"
                : "这段时间里没有 Claude Code 的会话记录。"}
            </p>
          ) : (
            <>
              <div className="claude-usage-tiles">
                <Tile
                  label="估算费用"
                  value={totals ? money(totals) : "—"}
                  hint={
                    totals?.costPartial
                      ? "有些模型没有定价，实际费用更高"
                      : "按本机模型定价表估算"
                  }
                />
                <Tile label="消息" value={String(totals?.messages ?? 0)} />
                <Tile label="输入" value={compact(totals?.tokens.input ?? 0)} />
                <Tile
                  label="输出"
                  value={compact(totals?.tokens.output ?? 0)}
                />
                <Tile
                  label="缓存写入"
                  value={compact(totals?.tokens.cacheWrite ?? 0)}
                />
                <Tile
                  label="缓存读取"
                  value={compact(totals?.tokens.cacheRead ?? 0)}
                />
              </div>

              <div className="claude-usage-activity">
                {rangeDays !== null && rangeDays <= 31 ? (
                  <DayBars rangeDays={rangeDays} byDay={byDay} />
                ) : (
                  <>
                    <Heatmap
                      days={overview.days}
                      rangeDays={rangeDays}
                      byDay={byDay}
                    />
                    <Facts days={overview.days} />
                  </>
                )}
              </div>

              <div className="claude-usage-breakdown">
                <div
                  className="claude-usage-tabs"
                  role="tablist"
                  aria-label="分组方式"
                >
                  {BREAKDOWNS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={tab === item.id}
                      onClick={() => setTab(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <BreakdownList
                  key={tab}
                  rows={rows}
                  label={BREAKDOWNS.find((b) => b.id === tab)?.label ?? ""}
                  showDetail={tab === "projects"}
                />
              </div>
            </>
          )}
          <p className="claude-usage-foot">
            读取了 {overview.filesScanned} 个会话文件
            {overview.truncated ? "（文件太多，只统计了一部分）" : ""}。
          </p>
        </div>
      )}
    </section>
  );
}

export default ClaudeUsageCard;
