/**
 * Time of a backup in the settings backup tables (配置备份 and 应用数据库):
 * "2026/10/09 18:47". Zero-padded, so the tabular digits line up down the
 * column; the UI is Chinese only, hence the fixed zh-CN locale.
 */
export function formatBackupTime(value: number | string): string {
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
