import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRequestLogs } from "@/lib/query/usage";
import {
  getFreshInputTokens,
  isUnpricedUsage,
  type LogFilters,
  type UsageRangeSelection,
} from "@/types/usage";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { UsageDateRangePicker } from "./UsageDateRangePicker";
import {
  fmtInt,
  fmtUsd,
  formatSeconds,
  getLocaleFromLanguage,
  parseFiniteNumber,
  usageSourceLabel,
} from "./format";
import { usageTable } from "./usageTable";

interface RequestLogTableProps {
  range: UsageRangeSelection;
  rangeLabel: string;
  appType?: string;
  providerName?: string;
  model?: string;
  refreshIntervalMs: number;
  onRangeChange?: (range: UsageRangeSelection) => void;
}

export function RequestLogTable({
  range,
  rangeLabel,
  appType: dashboardAppType,
  providerName,
  model,
  refreshIntervalMs,
  onRangeChange,
}: RequestLogTableProps) {
  const { t, i18n } = useTranslation();

  // 应用/Provider/模型筛选已上移到 Dashboard 顶栏（全局生效）；
  // 这里只保留日志特有的状态码筛选。
  const [statusCode, setStatusCode] = useState<number | undefined>(undefined);
  const [page, setPage] = useState(0);
  const [pageInput, setPageInput] = useState("");
  const pageSize = 20;

  const effectiveFilters: LogFilters = {
    appType:
      dashboardAppType && dashboardAppType !== "all"
        ? dashboardAppType
        : undefined,
    providerName,
    model,
    statusCode,
  };

  const { data: result, isLoading } = useRequestLogs({
    filters: effectiveFilters,
    range,
    page,
    pageSize,
    options: {
      refetchInterval: refreshIntervalMs > 0 ? refreshIntervalMs : false,
    },
  });

  const logs = result?.data ?? [];
  const total = result?.total ?? 0;
  const totalPages = Math.ceil(total / pageSize);

  useEffect(() => {
    setPage(0);
  }, [
    dashboardAppType,
    providerName,
    model,
    range.customEndDate,
    range.customStartDate,
    range.preset,
  ]);

  const handleGoToPage = () => {
    const trimmed = pageInput.trim();
    if (!/^\d+$/.test(trimmed)) return;
    const parsed = Number(trimmed);
    if (parsed < 1 || parsed > totalPages) return;
    setPage(parsed - 1);
    setPageInput("");
  };

  const language = i18n.resolvedLanguage || i18n.language || "en";
  const locale = getLocaleFromLanguage(language);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card/50 p-2 backdrop-blur-sm">
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Status code */}
          <Select
            value={statusCode?.toString() || "all"}
            onValueChange={(v) => {
              const parsed = Number.parseInt(v, 10);
              setStatusCode(
                v === "all" || !Number.isFinite(parsed) ? undefined : parsed,
              );
              setPage(0);
            }}
          >
            <SelectTrigger className="h-8 w-[100px] bg-background text-xs">
              <SelectValue placeholder={t("usage.statusCode")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("common.all")}</SelectItem>
              <SelectItem value="200">200 OK</SelectItem>
              <SelectItem value="400">400</SelectItem>
              <SelectItem value="401">401</SelectItem>
              <SelectItem value="429">429</SelectItem>
              <SelectItem value="500">500</SelectItem>
            </SelectContent>
          </Select>

          {onRangeChange && (
            <UsageDateRangePicker
              selection={range}
              triggerLabel={rangeLabel}
              onApply={onRangeChange}
            />
          )}
        </div>
      </div>

      {isLoading ? (
        <>
          <div className={usageTable.skeleton} aria-hidden="true" />
          <p className="sr-only" role="status">
            正在读取请求记录…
          </p>
        </>
      ) : (
        <>
          <div className="rounded-lg border border-border/50 bg-card/40 backdrop-blur-sm overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className={usageTable.th}>
                    {t("usage.time")}
                  </TableHead>
                  <TableHead className={usageTable.th}>线路</TableHead>
                  <TableHead className={usageTable.th}>
                    {t("usage.billingModel")}
                  </TableHead>
                  <TableHead className={usageTable.thNum}>
                    {t("usage.inputTokens")}
                  </TableHead>
                  <TableHead className={usageTable.thNum}>
                    {t("usage.outputTokens")}
                  </TableHead>
                  <TableHead className={usageTable.thNum}>
                    {t("usage.totalCost")}
                  </TableHead>
                  <TableHead className={usageTable.thNum}>用时</TableHead>
                  <TableHead className={usageTable.thNum}>首字</TableHead>
                  <TableHead className={usageTable.th}>
                    {t("usage.status")}
                  </TableHead>
                  <TableHead className={usageTable.th}>
                    {t("usage.source", { defaultValue: "来源" })}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={10}
                      className={cn(
                        usageTable.td,
                        "py-8 text-muted-foreground",
                      )}
                    >
                      所选范围内没有请求记录
                    </TableCell>
                  </TableRow>
                ) : (
                  logs.map((log) => {
                    const unpriced = isUnpricedUsage(log);
                    const freshInput = getFreshInputTokens(log);
                    const multiplier = parseFiniteNumber(log.costMultiplier);
                    const cacheNote = [
                      log.cacheReadTokens > 0 &&
                        `缓存命中 ${fmtInt(log.cacheReadTokens, locale)}`,
                      log.cacheCreationTokens > 0 &&
                        `缓存写入 ${fmtInt(log.cacheCreationTokens, locale)}`,
                    ]
                      .filter(Boolean)
                      .join(" · ");
                    const modelTitle =
                      log.requestModel && log.requestModel !== log.model
                        ? `${log.requestModel} → ${log.model}`
                        : log.model;
                    const provider =
                      log.providerName || t("usage.unknownProvider");
                    return (
                      <TableRow key={log.requestId}>
                        <TableCell
                          className={cn(
                            usageTable.td,
                            "whitespace-nowrap text-xs tabular-nums",
                          )}
                        >
                          {new Date(log.createdAt * 1000).toLocaleString(
                            locale,
                            {
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            },
                          )}
                        </TableCell>
                        <TableCell
                          className={cn(usageTable.td, "max-w-[160px]")}
                        >
                          <div className="truncate" title={provider}>
                            {provider}
                          </div>
                        </TableCell>
                        <TableCell
                          className={cn(
                            usageTable.td,
                            "max-w-[220px] font-mono text-xs",
                          )}
                        >
                          <div className="truncate" title={modelTitle}>
                            {log.requestModel &&
                            log.requestModel !== log.model ? (
                              <span>
                                {log.requestModel}
                                <span className="text-muted-foreground">
                                  {" → "}
                                  {log.model}
                                </span>
                              </span>
                            ) : (
                              log.model
                            )}
                          </div>
                        </TableCell>
                        <TableCell
                          className={usageTable.tdNum}
                          title={
                            log.inputTokens !== freshInput
                              ? `含缓存的原始输入 ${fmtInt(log.inputTokens, locale)}`
                              : undefined
                          }
                        >
                          <div>{fmtInt(freshInput, locale)}</div>
                          {cacheNote && (
                            <div className="text-[11px] text-muted-foreground">
                              {cacheNote}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className={usageTable.tdNum}>
                          {fmtInt(log.outputTokens, locale)}
                        </TableCell>
                        <TableCell className={usageTable.tdNum}>
                          <div
                            className={cn(
                              "font-medium",
                              unpriced && "text-muted-foreground",
                            )}
                          >
                            {unpriced
                              ? t("usage.unpriced", "未定价")
                              : fmtUsd(log.totalCostUsd, 4)}
                          </div>
                          {multiplier != null && multiplier !== 1 && (
                            <div className="text-[11px] text-muted-foreground">
                              倍率 ×{multiplier.toFixed(2)}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className={cn(usageTable.tdNum, "text-xs")}>
                          {formatSeconds(log.latencyMs)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            usageTable.tdNum,
                            "text-xs text-muted-foreground",
                          )}
                        >
                          {formatSeconds(log.firstTokenMs)}
                        </TableCell>
                        <TableCell
                          className={cn(usageTable.td, "tabular-nums")}
                        >
                          <span
                            className={
                              log.statusCode >= 200 && log.statusCode < 300
                                ? "text-[var(--success-fg)]"
                                : "text-[var(--danger-fg)]"
                            }
                          >
                            {log.statusCode}
                          </span>
                        </TableCell>
                        <TableCell
                          className={cn(
                            usageTable.td,
                            "whitespace-nowrap text-xs text-muted-foreground",
                          )}
                        >
                          {usageSourceLabel(log.dataSource)}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{t("usage.totalRecords", { total })}</span>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                aria-label="上一页"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              {(() => {
                const pages: (number | string)[] = [];
                if (totalPages <= 9) {
                  for (let i = 0; i < totalPages; i++) pages.push(i);
                } else {
                  const pageSet = new Set<number>();
                  for (let i = 0; i < 3; i++) pageSet.add(i);
                  for (let i = totalPages - 3; i < totalPages; i++)
                    pageSet.add(i);
                  for (
                    let i = Math.max(0, page - 1);
                    i <= Math.min(totalPages - 1, page + 1);
                    i++
                  )
                    pageSet.add(i);
                  const sorted = Array.from(pageSet).sort((a, b) => a - b);
                  for (let i = 0; i < sorted.length; i++) {
                    if (i > 0 && sorted[i] - sorted[i - 1] > 1) {
                      pages.push(`ellipsis-${i}`);
                    }
                    pages.push(sorted[i]);
                  }
                }
                return pages.map((p) =>
                  typeof p === "string" ? (
                    <span key={p} className="px-2 text-muted-foreground">
                      ...
                    </span>
                  ) : (
                    <Button
                      key={p}
                      variant={p === page ? "default" : "outline"}
                      size="sm"
                      className="h-8 w-8 p-0"
                      onClick={() => setPage(p)}
                    >
                      {p + 1}
                    </Button>
                  ),
                );
              })()}
              <Button
                size="sm"
                variant="outline"
                aria-label="下一页"
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              <div className="flex items-center gap-1 ml-2">
                <Input
                  type="text"
                  value={pageInput}
                  onChange={(e) => setPageInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleGoToPage();
                  }}
                  placeholder={t("usage.pageInputPlaceholder")}
                  className="h-8 w-16 text-center text-xs"
                />
                <Button variant="outline" size="sm" onClick={handleGoToPage}>
                  {t("usage.goToPage")}
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
