import React, { useEffect, useState } from "react";
import type { Provider } from "@/types";
import type { CANONICAL_STATION } from "@/data/canonicalData";
import {
  extractCodexBaseUrl,
  extractCodexModelName,
} from "@/utils/providerConfigUtils";

interface StationSignboardProps {
  currentProvider: Provider | null;
  designSample?: typeof CANONICAL_STATION;
  latencyMs?: number | null;
  testingLatency?: boolean;
  onTestSpeed?: () => void;
  onEdit?: () => void;
  undoReceipt?: {
    fromName: string;
    toName: string;
    backupId: string;
    timestamp: string;
    onUndo: () => void;
  } | null;
  onDefaultUndo?: () => void;
  runtimeLabel?: string;
  runtimeHint?: string;
  onOpenCodex?: () => void;
  openCodexLabel?: string;
  openCodexDisabled?: boolean;
}

export const StationSignboard: React.FC<StationSignboardProps> = ({
  currentProvider,
  designSample,
  latencyMs = null,
  testingLatency = false,
  onTestSpeed,
  onEdit,
  undoReceipt,
  runtimeLabel = "运行状态见 Codex 管理页",
  runtimeHint,
  onOpenCodex,
  openCodexLabel,
  openCodexDisabled,
}) => {
  const [undoCountdown, setUndoCountdown] = useState(8);
  const [undoing, setUndoing] = useState(false);

  useEffect(() => {
    if (!undoReceipt) {
      setUndoCountdown(8);
      setUndoing(false);
      return;
    }
    setUndoCountdown(8);
    setUndoing(false);
    const interval = setInterval(() => {
      setUndoCountdown((c) => (c > 1 ? c - 1 : 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [undoReceipt?.backupId]);

  if (!currentProvider) return null;

  const isOfficial =
    currentProvider.category === "official" ||
    currentProvider.id === "codex-official";

  const lineName = currentProvider.name || "未命名线路";
  const shortName = isOfficial
    ? lineName.includes("主力")
      ? "主"
      : lineName.includes("工作")
        ? "工"
        : "备"
    : lineName.includes("DeepSeek")
      ? "DS"
      : lineName.slice(0, 2).toUpperCase();

  const color =
    currentProvider.iconColor || (isOfficial ? "#1A1E24" : "#537197");

  // 根据配置解析端点与模型
  const configStr = String(currentProvider.settingsConfig?.config ?? "");
  const baseUrl = extractCodexBaseUrl(configStr);
  const host =
    baseUrl?.replace(/^https?:\/\//, "").split("/")[0] || "未设置端点";
  const model = extractCodexModelName(configStr) || "未设置模型";
  const protocol = currentProvider.meta?.apiFormat
    ? {
        openai_responses: "Responses",
        openai_chat: "Chat",
        anthropic: "Anthropic",
        gemini_native: "Gemini",
      }[currentProvider.meta.apiFormat]
    : "未确认";
  // Samples are opt-in, browser-development only, and tied to the fixture provider.
  const sample =
    import.meta.env.DEV &&
    !("__TAURI_INTERNALS__" in window) &&
    designSample?.providerId === currentProvider.id
      ? designSample
      : undefined;
  const isTesting = !sample && testingLatency;
  const displayLatency = sample?.latencyMs ?? latencyMs;
  const measured =
    !isTesting &&
    displayLatency != null &&
    Number.isFinite(displayLatency) &&
    displayLatency >= 0;

  const handleUndoClick = () => {
    if (sample || undoing) return;
    if (undoReceipt) {
      setUndoing(true);
      undoReceipt.onUndo();
    }
  };

  return (
    <div
      aria-label={sample ? "设计示例站牌，非本机运行状态" : undefined}
      className="box-border w-full flex flex-col gap-[8px] select-none"
    >
      {/* 站牌主体 (Pencil Frame 01 灯箱规范) */}
      <div
        data-pencil-name="站牌"
        className="box-border w-full h-fit shrink-0 flex flex-col gap-0 justify-start items-start bg-[#1A1E24] outline outline-1 outline-[#1A1E24] -outline-offset-[0.5px] rounded-[8px] overflow-hidden"
      >
        {/* 色带 (4px) */}
        <div
          data-pencil-name="色带"
          className="box-border w-full h-[4px] shrink-0"
          style={{ backgroundColor: color }}
        />

        <div
          data-pencil-name="主体"
          className="box-border w-full h-fit shrink-0 flex flex-col gap-[16px] p-[16px_24px] justify-start items-start"
        >
          {/* 顶行 (徽标 + 名称区 + 读数区 + 操作) */}
          <div
            data-pencil-name="顶行"
            className="box-border w-full h-fit shrink-0 flex flex-row gap-[16px] justify-start items-center"
          >
            {/* 徽标 */}
            <div
              data-pencil-name="徽标"
              className={`box-border w-[40px] shrink-0 h-[40px] flex flex-row justify-center items-center ${
                isOfficial
                  ? "rounded-full bg-[#1A1E24] border border-[#6F757B]"
                  : "rounded-[8px]"
              }`}
              style={{ backgroundColor: isOfficial ? undefined : color }}
            >
              <span className="text-[15px]/[21px] box-border text-[#FDFDFE] font-[Overpass,system-ui,sans-serif] font-bold text-left whitespace-nowrap">
                {shortName}
              </span>
            </div>

            {/* 名称区 */}
            <div
              data-pencil-name="名称区"
              className="box-border flex-1 h-fit flex flex-col gap-[2px] justify-start items-start"
            >
              <div
                data-pencil-name="标签"
                className="text-[13px]/[18px] box-border text-[#94999E] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal text-left whitespace-nowrap"
              >
                当前线路
              </div>
              <div
                data-pencil-name="名称行"
                className="box-border w-fit h-fit shrink-0 flex flex-row gap-[10px] justify-start items-center"
              >
                <div
                  data-pencil-name="名称"
                  className="text-[32px]/[37px] box-border text-[#F5F7F9] font-[Overpass,system-ui,sans-serif] font-bold text-left whitespace-nowrap"
                >
                  {lineName}
                </div>
                <div
                  data-pencil-name="类型"
                  className="box-border w-fit shrink-0 h-[22px] flex flex-row gap-0 px-2 justify-start items-center border border-[#6F757B] rounded-full"
                >
                  <div
                    data-pencil-name="类型字"
                    className="text-[13px]/[18px] box-border text-[#B4B8BC] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal text-left whitespace-nowrap"
                  >
                    {isOfficial
                      ? "官方 · ChatGPT 登录"
                      : currentProvider.meta?.apiFormat === "openai_responses"
                        ? "第三方 · Responses"
                        : "第三方 · API 密钥"}
                  </div>
                </div>
              </div>
            </div>

            {/* 读数区 */}
            <div
              data-pencil-name="读数区"
              className="box-border w-fit shrink-0 h-fit flex flex-col gap-[2px] justify-start items-end"
            >
              <div
                data-pencil-name="读数"
                className="text-[22px]/[25px] box-border text-[#F5F7F9] font-[Overpass,system-ui,sans-serif] font-bold text-left whitespace-nowrap"
              >
                {isTesting
                  ? "测速中…"
                  : measured
                    ? `${displayLatency} ms`
                    : "— ms"}
              </div>
              <div
                data-pencil-name="状态行"
                className="box-border w-fit h-fit shrink-0 flex flex-row gap-[6px] justify-start items-center"
              >
                <svg
                  data-pencil-name="状态图标"
                  viewBox="0 0 14 14"
                  className="box-border w-[14px] shrink-0 h-[14px]"
                  fill="none"
                >
                  <path
                    d="M9.73438 5.35938q0.10938 0.16406 0.10937 0.35546 0 0.19141-0.10937 0.30079l-3.22657 3.0625q-0.10938 0.10938-0.30078 0.10937-0.19141 0-0.30078-0.10937l-1.58594-1.53125q-0.21875-0.16406-0.16406-0.4375 0.05469-0.27344 0.30078-0.32813 0.24609-0.05469 0.41016 0.10938l1.3125 1.25781 2.95312-2.78906q0.10938-0.10938 0.30078-0.10938 0.19141 0 0.30078 0.16406l0-0.05468zm2.95312 1.64062q0 1.53125-0.76563 2.84375-0.76563 1.3125-2.07812 2.07813-1.3125 0.76563-2.84375 0.76562-1.53125 0-2.84375-0.76562-1.3125-0.76563-2.07813-2.07813-0.76563-1.3125-0.76562-2.84375 0-1.53125 0.76562-2.84375 0.76563-1.3125 2.07813-2.07813 1.3125-0.76563 2.84375-0.76562 1.53125 0 2.84375 0.76562 1.3125 0.76563 2.07813 2.07813 0.76563 1.3125 0.76562 2.84375zm-0.875 0q0-1.3125-0.65625-2.40625-0.65625-1.09375-1.75-1.75-1.09375-0.65625-2.40625-0.65625-1.3125 0-2.40625 0.65625-1.09375 0.65625-1.75 1.75-0.65625 1.09375-0.65625 2.40625 0 1.3125 0.65625 2.40625 0.65625 1.09375 1.75 1.75 1.09375 0.65625 2.40625 0.65625 1.3125 0 2.40625-0.65625 1.09375-0.65625 1.75-1.75 0.65625-1.09375 0.65625-2.40625z"
                    fill={measured ? "#71D790" : "#94999E"}
                  />
                </svg>
                <div
                  data-pencil-name="状态字"
                  style={{ color: measured ? "#71D790" : "#94999E" }}
                  className="text-[13px]/[18px] box-border text-[#71D790] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold text-left whitespace-nowrap"
                >
                  {sample?.status ??
                    (isTesting ? "测速中" : measured ? "测速完成" : "未测速")}
                </div>
                <div
                  data-pencil-name="时间"
                  className="text-[13px]/[18px] box-border text-[#94999E] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal text-left whitespace-nowrap"
                >
                  {sample?.testedAt ?? (measured ? "本次测量" : "暂无测速结果")}
                </div>
              </div>
            </div>

            {/* 操作 */}
            <div
              data-pencil-name="操作"
              className="box-border w-fit shrink-0 h-fit flex flex-row gap-[8px] pl-2 justify-start items-center"
            >
              <button
                type="button"
                onClick={sample ? undefined : onTestSpeed}
                disabled={Boolean(sample) || isTesting || !onTestSpeed}
                data-pencil-name="测速"
                className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] px-3 justify-center items-center bg-[#1A1E24] outline outline-1 outline-[#6F757B] -outline-offset-1 rounded-[4px] cursor-pointer hover:bg-[#262B2F] active:bg-[#31363D] transition disabled:opacity-50 text-[14px]/[20px] text-[#F5F7F9] font-['Noto_Sans_SC',system-ui,sans-serif]"
              >
                <svg
                  viewBox="0 0 14 14"
                  className="box-border w-[16px] shrink-0 h-[16px]"
                  fill="none"
                >
                  <path
                    d="M11.32031 4.42969q-0.875-0.875-1.99609-1.33985-1.12109-0.46484-2.32422-0.46484-1.36719 0-2.57031 0.57422-1.20313 0.57422-2.07813 1.58594-0.875 1.01172-1.20312 2.26953l-0.05469 0.21875q-0.21875 0.76563-0.21875 1.53125l0 1.25781q0 0.38281 0.24609 0.62891 0.24609 0.24609 0.62891 0.24609l10.5 0q0.38281 0 0.62891-0.24609 0.24609-0.24609 0.24609-0.62891l0-1.3125q0-1.20313-0.46484-2.35156-0.46484-1.14844-1.33985-1.96875zm0.92969 5.63281l-5.6875 0 3.17188-4.15625q0.10938-0.16406 0.08203-0.32813-0.02734-0.16406-0.16407-0.27343-0.13672-0.10938-0.30078-0.08203-0.16406 0.02734-0.32812 0.13671l-3.55469 4.70313-3.71875 0 0-1.25781q0-0.49219 0.10938-0.98438l1.36718 0.32813q0.16406 0 0.27344-0.10938 0.10938-0.10938 0.13672-0.27343 0.02734-0.16406-0.05469-0.30079-0.08203-0.13672-0.24609-0.13671l-1.25781-0.32813q0.54688-1.47656 1.75-2.40625 1.20313-0.92969 2.73437-1.09375l0 1.3125q0 0.16406 0.13672 0.30078 0.13672 0.13672 0.30078 0.13672 0.16406 0 0.30078-0.13672 0.13672-0.13672 0.13672-0.30078l0-1.3125q0.92969 0.10938 1.77734 0.49219 0.84766 0.38281 1.50391 1.03906 0.82031 0.82031 1.20313 1.96875l-1.20313 0.32813q-0.21875 0-0.30078 0.13671-0.08203 0.13672-0.05469 0.30079 0.02734 0.16406 0.13672 0.27343 0.10938 0.10938 0.32813 0.10938l1.36718-0.32813q0.05469 0.4375 0.05469 0.92969l0 1.3125z"
                    fill="currentColor"
                  />
                </svg>
                <span>测速</span>
              </button>
              <button
                type="button"
                onClick={sample ? undefined : onEdit}
                disabled={Boolean(sample) || !onEdit}
                data-pencil-name="编辑"
                className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] px-3 justify-center items-center bg-[#1A1E24] outline outline-1 outline-[#6F757B] -outline-offset-1 rounded-[4px] cursor-pointer hover:bg-[#262B2F] active:bg-[#31363D] transition text-[14px]/[20px] text-[#F5F7F9] font-['Noto_Sans_SC',system-ui,sans-serif]"
              >
                <svg
                  viewBox="0 0 14 14"
                  className="box-border w-[16px] shrink-0 h-[16px]"
                  fill="none"
                >
                  <path
                    d="M12.25 4.21094l-2.46094-2.46094q-0.21875-0.27344-0.60156-0.27344-0.38281 0-0.60156 0.27344l-6.5625 6.5625q-0.27344 0.27344-0.27344 0.60156l0 2.46094q0 0.38281 0.24609 0.62891 0.24609 0.24609 0.62891 0.24609l2.46094 0q0.32813 0 0.60156-0.27344l6.5625-6.5625q0.27344-0.21875 0.27344-0.60156 0-0.38281-0.27344-0.60156zm-7.16406 7.16406l-2.46094 0 0-2.46094 4.8125-4.8125 2.46094 2.46094-4.8125 4.8125zm5.41406-5.41406l-2.46094-2.46094 1.14844-1.14844 2.46094 2.46094-1.14844 1.14844z"
                    fill="currentColor"
                  />
                </svg>
                <span>编辑</span>
              </button>
            </div>
          </div>

          {/* 路径条 (Frame 01 4 节点地铁轨道贯穿条) */}
          <div
            data-pencil-name="路径条"
            className="box-border w-full h-fit shrink-0 flex flex-row gap-0 justify-start items-start"
          >
            {/* 站 1: Codex */}
            <div
              data-pencil-name="站 · Codex"
              className="box-border flex-1 min-w-0 h-fit flex flex-col gap-[10px] justify-start items-start"
            >
              <div
                data-pencil-name="轨"
                className="box-border w-full h-[12px] shrink-0 flex flex-row gap-0 justify-start items-center"
              >
                <div
                  data-pencil-name="点"
                  className="box-border w-[12px] shrink-0 h-[12px] bg-[#1A1E24] border-2 border-[#537197] rounded-full"
                />
                <div
                  data-pencil-name="线"
                  className="box-border flex-1 h-[2px] bg-[#537197]"
                />
              </div>
              <div
                data-pencil-name="标注"
                className="box-border w-full h-fit flex flex-col gap-[2px] pr-3 justify-start items-start"
              >
                <div
                  data-pencil-name="站名"
                  className="text-[13px]/[18px] box-border text-[#F5F7F9] font-[Overpass,system-ui,sans-serif] font-bold text-left whitespace-nowrap"
                >
                  Codex
                </div>
                <div
                  data-pencil-name="站注"
                  className="text-[13px]/[18px] box-border w-full text-[#94999E] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal text-left truncate"
                >
                  <span title={runtimeHint}>
                    {sample?.runtimeLabel ?? runtimeLabel}
                  </span>
                  {runtimeHint && (
                    <span className="sr-only">{runtimeHint}</span>
                  )}
                  {onOpenCodex && !sample && (
                    <button
                      type="button"
                      onClick={onOpenCodex}
                      disabled={openCodexDisabled}
                      className="ml-2 underline"
                    >
                      {openCodexLabel}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* 站 2: 本地代理 Proxy */}
            <div
              data-pencil-name="站 · 本地代理"
              className="box-border flex-1 min-w-0 h-fit flex flex-col gap-[10px] justify-start items-start"
            >
              <div
                data-pencil-name="轨"
                className="box-border w-full h-[12px] shrink-0 flex flex-row gap-0 justify-start items-center"
              >
                <div
                  data-pencil-name="点"
                  className="box-border w-[12px] shrink-0 h-[12px] bg-[#1A1E24] border-2 border-[#537197] rounded-full"
                />
                <div
                  data-pencil-name="线"
                  className="box-border flex-1 h-[2px] bg-[#537197]"
                />
              </div>
              <div
                data-pencil-name="标注"
                className="box-border w-full h-fit flex flex-col gap-[2px] pr-3 justify-start items-start"
              >
                <div
                  data-pencil-name="站名"
                  className="text-[13px]/[18px] box-border text-[#F5F7F9] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold text-left whitespace-nowrap"
                >
                  {sample?.hopName ?? (isOfficial ? "官方账户" : "API 线路")}
                </div>
                <div
                  data-pencil-name="站注"
                  className="text-[13px]/[18px] box-border w-full text-[#94999E] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal text-left truncate"
                >
                  {sample?.hopHint ?? `协议 · ${protocol}`}
                </div>
              </div>
            </div>

            {/* 站 3: 端点 Domain */}
            <div
              data-pencil-name={`站 · ${host}`}
              className="box-border flex-1 min-w-0 h-fit flex flex-col gap-[10px] justify-start items-start"
            >
              <div
                data-pencil-name="轨"
                className="box-border w-full h-[12px] shrink-0 flex flex-row gap-0 justify-start items-center"
              >
                <div
                  data-pencil-name="点"
                  className="box-border w-[12px] shrink-0 h-[12px] bg-[#1A1E24] border-2 border-[#537197] rounded-full"
                />
                <div
                  data-pencil-name="线"
                  className="box-border flex-1 h-[2px] bg-[#537197]"
                />
              </div>
              <div
                data-pencil-name="标注"
                className="box-border w-full h-fit flex flex-col gap-[2px] pr-3 justify-start items-start"
              >
                <div
                  data-pencil-name="站名"
                  className="text-[13px]/[18px] box-border text-[#F5F7F9] font-['Overpass_Mono',system-ui,sans-serif] font-normal text-left whitespace-nowrap truncate max-w-[150px]"
                >
                  {host}
                </div>
                <div
                  data-pencil-name="站注"
                  className="text-[13px]/[18px] box-border w-full text-[#94999E] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal text-left truncate"
                >
                  {sample?.endpointHint ??
                    (measured ? "端点测速完成" : "连通性未确认")}
                </div>
              </div>
            </div>

            {/* 站 4: 模型 Model */}
            <div
              data-pencil-name={`站 · ${model}`}
              className="box-border flex-1 min-w-0 h-fit flex flex-col gap-[10px] justify-start items-start"
            >
              <div
                data-pencil-name="轨"
                className="box-border w-full h-[12px] shrink-0 flex flex-row gap-0 justify-start items-center"
              >
                <div
                  data-pencil-name="点"
                  className="box-border w-[12px] shrink-0 h-[12px] bg-[#537197] border-2 border-[#537197] rounded-full"
                />
              </div>
              <div
                data-pencil-name="标注"
                className="box-border w-full h-fit flex flex-col gap-[2px] pr-3 justify-start items-start"
              >
                <div
                  data-pencil-name="站名"
                  className="text-[13px]/[18px] box-border text-[#F5F7F9] font-['Overpass_Mono',system-ui,sans-serif] font-normal text-left whitespace-nowrap truncate max-w-[150px]"
                >
                  {model}
                </div>
                <div
                  data-pencil-name="站注"
                  className="text-[13px]/[18px] box-border w-full text-[#94999E] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal text-left truncate"
                >
                  {sample?.modelHint ?? "配置模型"}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 换乘回执条 (UndoReceipt) Frame 01 1:1 */}
      <div
        aria-live="polite"
        data-pencil-name="回执行"
        className="box-border w-full h-[32px] shrink-0 flex flex-row gap-[8px] p-[0px_4px_0px_12px] justify-start items-center bg-[#F5F7F9] dark:bg-[#23282D] rounded-[4px]"
      >
        <svg
          data-pencil-name="图标"
          viewBox="0 0 14 14"
          className="box-border w-[14px] shrink-0 h-[14px]"
          fill="none"
        >
          <path
            d="M7.4375 4.375l0 2.35156 2.07813 1.20313q0.10938 0.05469 0.16406 0.1914 0.05469 0.13672 0.02734 0.30078-0.02734 0.16406-0.16406 0.2461-0.13672 0.08203-0.27344 0.08203-0.13672 0-0.1914-0.05469l-2.40625-1.42187-0.05469-0.05469-0.05469-2.84375q0-0.16406 0.13672-0.30078 0.13672-0.13672 0.30078-0.13672 0.16406 0 0.30078 0.13672 0.13672 0.13672 0.13672 0.30078zm3.28125-1.09375q-1.03906-0.98438-2.37891-1.33984-1.33984-0.35547-2.67968 0-1.33984 0.35547-2.37891 1.33984l-1.09375 1.09375 0-1.09375q0-0.27344-0.21875-0.41016-0.21875-0.13672-0.4375 0-0.21875 0.13672-0.21875 0.41016l0 2.1875 0.16406 0.32813 2.46094 0.05468q0.16406 0 0.30078-0.10937 0.13672-0.10938 0.13672-0.30078 0-0.19141-0.13672-0.32813-0.13672-0.13672-0.30078-0.13672l-1.14844 0 1.09375-1.09375q0.875-0.82031 1.9961-1.12109 1.12109-0.30078 2.24218 0 1.12109 0.30078 1.96875 1.14844 0.84766 0.84766 1.14844 1.96875 0.30078 1.12109 0 2.24218-0.30078 1.12109-1.14844 1.96875-0.84766 0.84766-1.96875 1.14844-1.12109 0.30078-2.24218 0-1.12109-0.30078-1.9961-1.12109-0.10938-0.16406-0.30078-0.16407-0.19141 0-0.30078 0.13672-0.10938 0.13672-0.10938 0.32813 0 0.19141 0.10938 0.30078 1.03906 0.98438 2.37891 1.33984 1.33984 0.35547 2.67968 0 1.33984-0.35547 2.35157-1.36718 1.01172-1.01172 1.36718-2.35157 0.35547-1.33984 0-2.67968-0.35547-1.33984-1.33984-2.37891z"
            fill="#646970"
          />
        </svg>
        <div
          data-pencil-name="文字"
          className="text-[13px]/[18px] box-border flex-1 text-[#484E55] dark:text-[#BABEC3] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal truncate"
        >
          {sample?.receipt ??
            (undoReceipt
              ? `${undoReceipt.timestamp} 从 ${undoReceipt.fromName} 切换到 ${undoReceipt.toName}`
              : "暂无本次会话的切换记录")}
        </div>
        <button
          type="button"
          disabled={Boolean(sample) || !undoReceipt || undoing}
          title={
            sample ? "设计示例，不执行撤销" : "切回上一线路，不恢复配置快照"
          }
          data-pencil-name="撤销"
          onClick={handleUndoClick}
          className="box-border w-fit shrink-0 h-[28px] flex flex-row gap-[6px] p-[0px_8px] justify-center items-center rounded-[4px] cursor-pointer hover:bg-[#E7EAED] dark:hover:bg-[#31363D] transition select-none"
        >
          <div
            data-pencil-name="文字"
            className="text-[13px]/[18px] box-border text-[#12161C] dark:text-[#EEF0F3] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal whitespace-nowrap"
          >
            {sample
              ? "撤销"
              : undoing
                ? "切回中…"
                : undoReceipt
                  ? `切回 (${undoCountdown}s)`
                  : "切回"}
          </div>
        </button>
      </div>
    </div>
  );
};
