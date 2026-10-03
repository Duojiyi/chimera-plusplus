import React from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  AlertTriangle,
  ExternalLink,
  ShieldCheck,
  X,
} from "lucide-react";

export interface DeepLinkImportData {
  tool: "codex" | "mcode" | "opencode" | "claude";
  name: string;
  baseUrl: string;
  wireApi?: string;
  model: string;
  maskedKey?: string;
  rawLink: string;
  timeText?: string;
}

interface DeepLinkModalProps {
  isOpen: boolean;
  onClose: () => void;
  data: DeepLinkImportData | null;
  onImportSuccess?: (item: DeepLinkImportData) => void;
  onNavigateToTool?: (toolId: string) => void;
}

export const DeepLinkModal: React.FC<DeepLinkModalProps> = ({
  isOpen,
  onClose,
  data,
  onImportSuccess,
  onNavigateToTool,
}) => {
  if (!isOpen || !data) return null;

  const isMcodeRejected = data.tool === "mcode";

  const handleConfirmImport = () => {
    toast.success(`已成功导入线路「${data.name}」到 Codex`);
    onImportSuccess?.(data);
    onClose();
  };

  const handleOpenMcodeAdd = () => {
    toast.info("正在前往设置启用 MiniMax Code…");
    onNavigateToTool?.("mcode");
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/55 backdrop-blur-[2px]">
      {/* 遮罩背景 */}
      <div className="absolute inset-0" onClick={onClose} />

      {/* 对话框主体 */}
      <div className="relative w-full max-w-[540px] bg-[#FDFDFE] dark:bg-[#1A1E24] outline outline-1 outline-[#DDE0E3] dark:outline-[#31363D] rounded-[8px] shadow-2xl p-[24px] flex flex-col gap-[16px] text-[#12161C] dark:text-[#EEF0F3] z-10">
        {/* 关闭按钮 */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-[16px] right-[16px] w-[28px] h-[28px] flex items-center justify-center rounded text-[#646970] dark:text-[#8D9398] hover:bg-[#F2F4F6] dark:hover:bg-[#252A31] border-none bg-transparent cursor-pointer"
        >
          <X size={16} />
        </button>

        {isMcodeRejected ? (
          /* ================= Frame 13F: MiniMax Code 拒绝深链 ================= */
          <div
            data-pencil-name="对话框 · 拒绝深链"
            className="flex flex-col gap-[16px]"
          >
            {/* 头 */}
            <div className="flex flex-row items-center gap-[12px]">
              <div className="w-[32px] h-[32px] rounded-[6px] bg-[#776894] flex items-center justify-center text-[#FDFDFE] font-bold text-[14px]">
                Mc
              </div>
              <h2 className="text-[18px]/[24px] font-bold m-0 font-['Noto_Sans_SC',system-ui,sans-serif]">
                MiniMax Code 不接受从链接导入
              </h2>
            </div>

            {/* 正文 */}
            <p className="text-[13px]/[20px] text-[#484E55] dark:text-[#BABEC3] m-0">
              这条链接想把线路「{data.name}」导入到 MiniMax Code。MiniMax Code
              不接受从链接导入，所以什么都没有改动；这条线路仍然可以在 Chimera++
              里添加。
            </p>

            {/* 链接内容 (只读) */}
            <div className="flex flex-col gap-[8px] p-[12px_14px] bg-[#F8F9FA] dark:bg-[#12161C]/50 rounded-[6px] border border-[#E7EAED] dark:border-[#2D333B]">
              <div className="text-[12px]/[16px] text-[#646970] dark:text-[#8D9398] font-bold">
                链接里的内容（只读）
              </div>
              <div className="grid grid-cols-[64px_1fr] gap-[6px] text-[13px]/[18px]">
                <span className="text-[#646970] dark:text-[#8D9398]">名称</span>
                <span className="font-bold text-[#12161C] dark:text-[#EEF0F3]">
                  {data.name}
                </span>

                <span className="text-[#646970] dark:text-[#8D9398]">地址</span>
                <span className="font-['Overpass_Mono',system-ui,sans-serif] text-[#484E55] dark:text-[#BABEC3] break-all">
                  {data.baseUrl}
                </span>

                <span className="text-[#646970] dark:text-[#8D9398]">模型</span>
                <span className="font-['Overpass_Mono',system-ui,sans-serif] text-[#484E55] dark:text-[#BABEC3]">
                  {data.model}
                </span>

                <span className="text-[#646970] dark:text-[#8D9398]">密钥</span>
                <span className="text-[#646970] dark:text-[#8D9398]">
                  {data.maskedKey || "链接里没有密钥"}
                </span>
              </div>
            </div>

            {/* 下一步提示 */}
            <div className="flex flex-col gap-[8px] text-[13px]/[18px] text-[#484E55] dark:text-[#BABEC3]">
              <div className="flex items-start gap-[8px]">
                <ExternalLink
                  size={16}
                  className="text-[#12161C] dark:text-[#EEF0F3] shrink-0 mt-[2px]"
                />
                <span>
                  在 Chimera++ 的 MiniMax Code
                  页点「添加条目」，上面的内容可以一键带入。
                </span>
              </div>
              <div className="flex items-start gap-[8px] text-[#646970] dark:text-[#8D9398]">
                <AlertCircle size={16} className="shrink-0 mt-[2px]" />
                <span>
                  MiniMax Code 还没有启用，会先打开「设置 ›
                  工具」，启用后再回到添加表单。
                </span>
              </div>
            </div>

            {/* 按钮行 */}
            <div className="flex flex-row justify-end items-center gap-[10px] pt-[8px]">
              <button
                type="button"
                onClick={onClose}
                className="h-[32px] px-[14px] bg-[#FDFDFE] dark:bg-[#252A31] outline outline-1 outline-[#81878D] -outline-offset-[0.5px] rounded-[4px] text-[13px] text-[#12161C] dark:text-[#EEF0F3] font-bold cursor-pointer hover:bg-[#F2F4F6] border-none"
              >
                关闭
              </button>
              <button
                type="button"
                onClick={handleOpenMcodeAdd}
                className="h-[32px] px-[16px] bg-[#12161C] dark:bg-[#EEF0F3] text-[#FDFDFE] dark:text-[#12161C] rounded-[4px] text-[13px] font-bold cursor-pointer hover:bg-[#2A2F37] border-none"
              >
                在 MiniMax Code 中添加…
              </button>
            </div>
          </div>
        ) : (
          /* ================= Frame 13E: 深链导入确认 (Codex) ================= */
          <div
            data-pencil-name="对话框 · 深链导入"
            className="flex flex-col gap-[14px]"
          >
            {/* 头 */}
            <div className="flex flex-col gap-[2px]">
              <h2 className="text-[18px]/[24px] font-bold m-0 font-['Noto_Sans_SC',system-ui,sans-serif]">
                从链接导入一条线路到 Codex？
              </h2>
              <div className="text-[12px]/[16px] text-[#646970] dark:text-[#8D9398]">
                来源：浏览器里打开的链接 · {data.timeText || "今天 14:25"} ·
                导入后不会自动切换
              </div>
            </div>

            {/* 内容条目 */}
            <div className="flex flex-col gap-[6px] p-[12px_14px] bg-[#F8F9FA] dark:bg-[#12161C]/50 rounded-[6px] border border-[#E7EAED] dark:border-[#2D333B] text-[13px]/[18px]">
              <div className="grid grid-cols-[70px_1fr] items-center gap-[4px]">
                <span className="text-[#646970] dark:text-[#8D9398]">名称</span>
                <span className="font-bold text-[#12161C] dark:text-[#EEF0F3]">
                  {data.name}
                </span>
              </div>

              <div className="grid grid-cols-[70px_1fr] items-center gap-[4px]">
                <span className="text-[#646970] dark:text-[#8D9398]">地址</span>
                <span className="font-['Overpass_Mono',system-ui,sans-serif] text-[#484E55] dark:text-[#BABEC3] break-all">
                  {data.baseUrl}
                </span>
              </div>

              <div className="grid grid-cols-[70px_1fr] items-center gap-[4px]">
                <span className="text-[#646970] dark:text-[#8D9398]">协议</span>
                <div className="flex items-center gap-[8px]">
                  <span className="text-[#12161C] dark:text-[#EEF0F3]">
                    {data.wireApi || "Chat · 经本地代理 · Responses → Chat"}
                  </span>
                  <span className="text-[11px] px-[6px] py-[1px] bg-[#E7EAED] dark:bg-[#31363D] text-[#484E55] dark:text-[#BABEC3] rounded">
                    链接指定
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-[70px_1fr] items-center gap-[4px]">
                <span className="text-[#646970] dark:text-[#8D9398]">
                  默认模型
                </span>
                <span className="font-['Overpass_Mono',system-ui,sans-serif] text-[#12161C] dark:text-[#EEF0F3]">
                  {data.model}
                </span>
              </div>

              <div className="grid grid-cols-[70px_1fr] items-center gap-[4px]">
                <span className="text-[#646970] dark:text-[#8D9398]">密钥</span>
                <div className="flex flex-col gap-[2px]">
                  <span className="font-['Overpass_Mono',system-ui,sans-serif] text-[#12161C] dark:text-[#EEF0F3]">
                    {data.maskedKey || "sk-••••7Qa2"}
                  </span>
                  <span className="text-[12px]/[16px] text-[#05773B] dark:text-[#38A169]">
                    链接里带了密钥，导入后只存入 Windows 凭据管理器
                  </span>
                </div>
              </div>
            </div>

            {/* 原始链接 */}
            <div className="flex flex-col gap-[4px]">
              <span className="text-[12px]/[16px] text-[#646970] dark:text-[#8D9398]">
                原始链接（密钥已遮蔽）
              </span>
              <div className="p-[8px_10px] bg-[#ECEFF2] dark:bg-[#20252D] rounded-[4px] font-['Overpass_Mono',system-ui,sans-serif] text-[12px]/[16px] text-[#484E55] dark:text-[#A0A6AD] break-all whitespace-pre-wrap select-all">
                {data.rawLink}
              </div>
            </div>

            {/* 写入说明 */}
            <div className="flex flex-col gap-[6px] text-[12px]/[16px]">
              <div className="flex items-center gap-[6px] text-[#484E55] dark:text-[#BABEC3]">
                <ShieldCheck size={14} className="text-[#05773B]" />
                <span className="text-[#646970] dark:text-[#8D9398]">
                  写入：
                </span>
                <span className="font-['Overpass_Mono',system-ui,sans-serif] text-[#12161C] dark:text-[#EEF0F3]">
                  %APPDATA%\Chimera\routes.json
                </span>
                <span className="text-[#05773B] font-bold">
                  （新增 1 条线路）
                </span>
              </div>
              <div className="text-[#646970] dark:text-[#8D9398] pl-[20px]">
                不改动 %USERPROFILE%\.codex\config.toml，切换时才会写入
              </div>
            </div>

            {/* 提醒 */}
            <div className="flex items-start gap-[8px] p-[10px_12px] bg-[#FFF8F2] dark:bg-[#2A2318] border border-[#F5D8BA] dark:border-[#523C1B] rounded-[6px] text-[12px]/[16px] text-[#915C08] dark:text-[#E2A03F]">
              <AlertTriangle size={15} className="shrink-0 mt-[1px]" />
              <span>任何网页都能生成这种链接。只在你认识这个来源时导入。</span>
            </div>

            {/* 操作按钮 */}
            <div className="flex flex-row justify-end items-center gap-[10px] pt-[6px]">
              <button
                type="button"
                onClick={onClose}
                className="h-[32px] px-[14px] bg-[#FDFDFE] dark:bg-[#252A31] outline outline-1 outline-[#81878D] -outline-offset-[0.5px] rounded-[4px] text-[13px] text-[#12161C] dark:text-[#EEF0F3] font-bold cursor-pointer hover:bg-[#F2F4F6] border-none"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleConfirmImport}
                className="h-[32px] px-[16px] bg-[#12161C] dark:bg-[#EEF0F3] text-[#FDFDFE] dark:text-[#12161C] rounded-[4px] text-[13px] font-bold cursor-pointer hover:bg-[#2A2F37] border-none"
              >
                导入线路
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
