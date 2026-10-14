import { useTranslation } from "react-i18next";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useProviderStats } from "@/lib/query/usage";
import { cn } from "@/lib/utils";
import { fmtUsd, formatSeconds } from "./format";
import { usageTable } from "./usageTable";
import type { UsageRangeSelection } from "@/types/usage";

interface ProviderStatsTableProps {
  range: UsageRangeSelection;
  appType?: string;
  providerName?: string;
  model?: string;
  refreshIntervalMs: number;
}

export function ProviderStatsTable({
  range,
  appType,
  providerName,
  model,
  refreshIntervalMs,
}: ProviderStatsTableProps) {
  const { t } = useTranslation();
  const { data: stats, isLoading } = useProviderStats(
    range,
    { appType, providerName, model },
    {
      refetchInterval: refreshIntervalMs > 0 ? refreshIntervalMs : false,
    },
  );

  if (isLoading) {
    return <div className={usageTable.skeleton} aria-hidden="true" />;
  }

  return (
    <div className="rounded-lg border border-border/50 bg-card/40 backdrop-blur-sm overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className={usageTable.th}>线路</TableHead>
            <TableHead className={usageTable.thNum}>
              {t("usage.requests", "请求数")}
            </TableHead>
            <TableHead className={usageTable.thNum}>词元</TableHead>
            <TableHead className={usageTable.thNum}>
              {t("usage.cost", "成本")}
            </TableHead>
            <TableHead className={usageTable.thNum}>
              {t("usage.successRate", "成功率")}
            </TableHead>
            <TableHead className={usageTable.thNum}>
              {t("usage.avgLatency", "平均延迟")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {stats?.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={6}
                className={cn(usageTable.td, "py-8 text-muted-foreground")}
              >
                所选范围内没有线路统计
              </TableCell>
            </TableRow>
          ) : (
            stats?.map((stat) => (
              <TableRow key={stat.providerId}>
                <TableCell className={cn(usageTable.td, "font-medium")}>
                  {stat.providerName}
                </TableCell>
                <TableCell className={usageTable.tdNum}>
                  {stat.requestCount.toLocaleString("zh-CN")}
                </TableCell>
                <TableCell className={usageTable.tdNum}>
                  {stat.totalTokens.toLocaleString("zh-CN")}
                </TableCell>
                <TableCell className={usageTable.tdNum}>
                  {fmtUsd(stat.totalCost, 4)}
                </TableCell>
                <TableCell className={usageTable.tdNum}>
                  {stat.successRate.toFixed(1)}%
                </TableCell>
                <TableCell className={usageTable.tdNum}>
                  {formatSeconds(stat.avgLatencyMs)}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
