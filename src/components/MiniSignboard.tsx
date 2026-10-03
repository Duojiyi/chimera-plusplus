import type { ConnectionState } from "@/chimeraUtils";
import type { Provider } from "@/types";
import { LoaderCircle } from "lucide-react";
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
  const isOfficial =
    currentProvider?.category === "official" ||
    currentProvider?.id === "codex-official";
  const lineName = currentProvider
    ? currentProvider.name || "未命名线路"
    : unresolvedLabel;
  const shortName = isOfficial
    ? "官"
    : lineName.includes("DeepSeek")
      ? "DS"
      : /[\u3400-\u9fff]/.test(lineName[0])
        ? lineName[0]
        : lineName.slice(0, 2).toUpperCase();
  const compactLineName =
    lineName.length > 12 ? lineName.slice(0, 12) + "…" : lineName;
  const color = currentProvider
    ? currentProvider.iconColor || (isOfficial ? "#CED1D5" : "#537197")
    : "var(--plate-fg-3)";
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
        style={{ backgroundColor: color }}
      />
      <span className="mini-signboard-tool">{appTitle}</span>
      <span className="mini-signboard-track" aria-hidden="true" />
      <span className="mini-signboard-line">
        {currentProvider && (
          <span
            className="mini-signboard-badge"
            style={{
              backgroundColor: color,
              borderRadius: isOfficial ? "50%" : undefined,
              color: isOfficial ? "#1F2328" : undefined,
            }}
          >
            {shortName}
          </span>
        )}
        <span
          className="mini-signboard-name"
          data-unresolved={!currentProvider}
        >
          {compactLineName}
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
