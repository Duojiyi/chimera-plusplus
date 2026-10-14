import type { ConnectionState } from "@/chimeraUtils";
import type { Provider } from "@/types";
import { LoaderCircle } from "lucide-react";
import { isOfficialLine } from "@/utils/lineBadge";
import { LineBadge, lineIdentityColor } from "@/components/LineBadge";
import "./MiniSignboard.css";

interface MiniSignboardProps {
  currentProvider: Provider | null;
  connection: ConnectionState;
  unresolvedLabel?: string;
  appTitle?: string;
  onClick?: () => void;
}

export function MiniSignboard({
  currentProvider,
  connection,
  unresolvedLabel = "未选择线路",
  appTitle = "Codex",
  onClick,
}: MiniSignboardProps) {
  const lineName = currentProvider
    ? currentProvider.name || "未命名线路"
    : unresolvedLabel;
  const stripe = !currentProvider
    ? "var(--plate-fg-3)"
    : isOfficialLine(currentProvider)
      ? "var(--plate-fg-2)"
      : lineIdentityColor(currentProvider);
  const latency = connection.kind === "connected" ? connection.latencyMs : null;
  const slow = latency != null && latency >= 1000;
  const reading =
    connection.kind === "checking"
      ? "测速中…"
      : connection.kind === "error"
        ? "连接失败"
        : latency != null
          ? `${latency} ms${slow ? " 慢" : ""}`
          : "未测速";
  const statusColor =
    connection.kind === "error"
      ? "var(--plate-danger)"
      : latency != null
        ? slow
          ? "var(--plate-warning)"
          : "var(--plate-success)"
        : "var(--plate-fg-3)";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`当前线路：${lineName}${currentProvider ? `，${reading}` : ""}`}
      className="mini-signboard"
      title={
        connection.kind === "error" ? connection.message : "点击返回线路页"
      }
      data-tauri-no-drag
    >
      <span
        className="mini-signboard-stripe"
        style={{ backgroundColor: stripe }}
      />
      <span className="mini-signboard-tool">{appTitle}</span>
      <span className="mini-signboard-track" aria-hidden="true" />
      <span className="mini-signboard-line">
        {currentProvider && (
          <LineBadge line={currentProvider} size="sm" onPlate />
        )}
        <span
          className="mini-signboard-name"
          data-unresolved={!currentProvider}
          title={lineName}
        >
          {lineName}
        </span>
      </span>
      {currentProvider && (
        <>
          <span className="mini-signboard-track" aria-hidden="true" />
          <span className="mini-signboard-status" role="status">
            {connection.kind === "checking" ? (
              <LoaderCircle
                size={14}
                className="animate-spin"
                aria-hidden="true"
              />
            ) : (
              <span
                className="mini-signboard-dot"
                style={{ backgroundColor: statusColor }}
                aria-hidden="true"
              />
            )}
            <span
              style={
                connection.kind === "error"
                  ? { color: statusColor, fontWeight: 700 }
                  : undefined
              }
            >
              {reading}
            </span>
          </span>
        </>
      )}
    </button>
  );
}
