import type { DailyStats } from "@/types/usage";
import { totalDailyTokens } from "@/utils/usageMetrics";

const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
const number = new Intl.NumberFormat("zh-CN");

export function UsageCalendar({ days }: { days: DailyStats[] }) {
  const first = days[0]?.date.slice(0, 10);
  if (!first)
    return <p className="usage-calendar-empty">这段时间没有每日记录。</p>;

  // The backend provides one bucket per local date. Interpret only the
  // calendar date here so DST and UTC offsets don't shift the weekday.
  const firstWeekday = new Date(`${first}T00:00:00Z`).getUTCDay();
  const offset = Number.isFinite(firstWeekday) ? (firstWeekday + 6) % 7 : 0;
  const peak = Math.max(0, ...days.map(totalDailyTokens));
  const active = days.filter((day) => totalDailyTokens(day) > 0).length;

  return (
    <div className="usage-calendar">
      <div
        className="usage-calendar-grid"
        role="img"
        aria-label={`每日词元热力图，${days.length} 天中 ${active} 天有词元，最高 ${number.format(peak)} 词元；逐日数据见表格`}
      >
        {weekdays.map((day) => (
          <span key={day} className="usage-calendar-weekday" aria-hidden="true">
            周{day}
          </span>
        ))}
        {Array.from({ length: offset }, (_, index) => (
          <span key={`pad-${index}`} aria-hidden="true" />
        ))}
        {days.map((day) => {
          const date = day.date.slice(0, 10);
          const tokens = totalDailyTokens(day);
          const intensity =
            tokens > 0 ? Math.min(4, Math.ceil((tokens / peak) * 4)) : 0;
          const label = `${date} · ${number.format(tokens)} 词元 · ${number.format(day.requestCount)} 次请求`;
          return (
            <span
              key={date}
              className="usage-calendar-cell"
              data-level={intensity}
              title={label}
              aria-hidden="true"
            >
              {Number(date.slice(8, 10))}
            </span>
          );
        })}
      </div>
      <div className="usage-calendar-legend">
        <span>
          {active} / {days.length} 天有词元用量
        </span>
        <span
          className="usage-calendar-scale"
          aria-label="颜色从浅到深，对应每日词元从零到本期峰值"
        >
          <span aria-hidden="true">少</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <i
              key={level}
              className="usage-calendar-cell"
              data-level={level}
              aria-hidden="true"
            />
          ))}
          <span aria-hidden="true">多</span>
        </span>
      </div>
    </div>
  );
}
