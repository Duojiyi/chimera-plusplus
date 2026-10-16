import { extractErrorMessage } from "@/utils/errorUtils";

// AppError::Config / AppError::InvalidInput carry product sentences written for
// the user (why a restore was refused). Other errors can carry local paths or
// native detail, so they stay behind the caller's generic text.
const REFUSAL_PREFIXES = ["配置错误: ", "无效输入: "];

/** The backend's reason for refusing a backup operation, or null when it is not safe to show. */
export function restoreRefusal(error: unknown): string | null {
  const text = extractErrorMessage(error).trim();
  const prefix = REFUSAL_PREFIXES.find((item) => text.startsWith(item));
  const reason = prefix ? text.slice(prefix.length).trim() : "";
  return reason || null;
}
