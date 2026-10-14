import { ChevronDown, CircleAlert } from "lucide-react";
import type { SessionSyncResult } from "@/types/usage";

/** Error messages listed under the counts; the rest are summarised. */
const LISTED_ERRORS = 5;

const positive = (value: number | undefined) =>
  value && value > 0 ? value : 0;
const n = (value: number) => value.toLocaleString("zh-CN");

/**
 * What the last sync or rebuild reported as left out of the statistics.
 * Only counts the backend returned; nothing is estimated.
 */
export function usageCoverageGaps(result: SessionSyncResult | null): string[] {
  if (!result) return [];
  const failed = positive(result.errors?.length);
  const deferred = positive(result.deferredFiles);
  const skippedLines = positive(result.skippedLines);
  return [
    failed && `${n(failed)} 个会话文件读取失败`,
    deferred && `${n(deferred)} 个会话文件暂未计入，之后同步时会再次尝试`,
    skippedLines && `${n(skippedLines)} 行记录无法解析，已跳过`,
  ].filter((gap): gap is string => Boolean(gap));
}

export function UsageCoverageNote({
  result,
}: {
  result: SessionSyncResult | null;
}) {
  const gaps = usageCoverageGaps(result);
  if (!result || gaps.length === 0) return null;
  const errors = result.errors ?? [];
  const files = positive(errors.length) + positive(result.deferredFiles);
  const lines = positive(result.skippedLines);
  const scope = [
    files && `${n(files)} 个会话文件`,
    lines && `${n(lines)} 行记录`,
  ]
    .filter(Boolean)
    .join("、");
  return (
    <details className="usage-coverage">
      <summary>
        <CircleAlert size={15} aria-hidden="true" />
        <span>部分记录未计入</span>
        <small>涉及 {scope}</small>
        <ChevronDown
          size={15}
          aria-hidden="true"
          className="usage-coverage-chevron"
        />
      </summary>
      <div className="usage-coverage-body">
        <ul>
          {gaps.map((gap) => (
            <li key={gap}>{gap}</li>
          ))}
        </ul>
        {errors.length > 0 && (
          <ul className="usage-coverage-errors" aria-label="读取失败的文件">
            {errors.slice(0, LISTED_ERRORS).map((error, index) => (
              <li key={index} title={error}>
                {error}
              </li>
            ))}
            {errors.length > LISTED_ERRORS && (
              <li>另有 {n(errors.length - LISTED_ERRORS)} 条未列出</li>
            )}
          </ul>
        )}
        <p>本页的词元和请求数不含这些记录。</p>
      </div>
    </details>
  );
}
