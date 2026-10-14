import { useTranslation } from "react-i18next";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useModelStats } from "@/lib/query/usage";
import { cn } from "@/lib/utils";
import { fmtUsd } from "./format";
import { usageTable } from "./usageTable";
import type { UsageRangeSelection } from "@/types/usage";

interface ModelStatsTableProps {
  range: UsageRangeSelection;
  appType?: string;
  providerName?: string;
  model?: string;
  refreshIntervalMs: number;
}

export function ModelStatsTable({
  range,
  appType,
  providerName,
  model,
  refreshIntervalMs,
}: ModelStatsTableProps) {
  const { t } = useTranslation();
  const { data: stats, isLoading } = useModelStats(
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
            <TableHead className={usageTable.th}>
              {t("usage.model", "模型")}
            </TableHead>
            <TableHead className={usageTable.thNum}>
              {t("usage.requests", "请求数")}
            </TableHead>
            <TableHead className={usageTable.thNum}>词元</TableHead>
            <TableHead className={usageTable.thNum}>
              {t("usage.totalCost", "总成本")}
            </TableHead>
            <TableHead className={usageTable.thNum}>
              {t("usage.avgCost", "平均成本")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {stats?.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={5}
                className={cn(usageTable.td, "py-8 text-muted-foreground")}
              >
                所选范围内没有模型统计
              </TableCell>
            </TableRow>
          ) : (
            stats?.map((stat) => (
              <TableRow key={stat.model}>
                <TableCell className={cn(usageTable.td, "font-mono text-xs")}>
                  {stat.model}
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
                  {fmtUsd(stat.avgCostPerRequest, 6)}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
