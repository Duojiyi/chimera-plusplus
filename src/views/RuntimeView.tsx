import { useState } from "react";
import { toast } from "sonner";
import {
  RotateCw,
  Wrench,
  RotateCcw,
  Trash2,
  ArrowUpCircle,
  ExternalLink,
  AlertTriangle,
  HelpCircle,
  Info,
  X,
  XCircle,
  Globe,
  Package,
  Circle,
  LoaderCircle,
} from "lucide-react";

interface RuntimeViewProps {
  onRefreshed?: () => void;
}

type RuntimeMode = "installed" | "installing" | "failed";

export function RuntimeView({ onRefreshed }: RuntimeViewProps) {
  // 运行模式：installed (09A 常态) | installing (09C 安装中) | failed (09D 失败)
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("installed");
  const [installMethod, setInstallMethod] = useState<"npm" | "standalone">(
    "npm",
  );

  const [upgrading, setUpgrading] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);

  // Frame 13D / 13DD / 13D2 破坏性确认弹窗状态
  const [uninstallModalOpen, setUninstallModalOpen] = useState(false);
  const [deleteConfigChecked, setDeleteConfigChecked] = useState(false);

  const handleRedetect = () => {
    toast.info("正在检测 Codex CLI 状态...", {
      description:
        runtimeMode === "installed"
          ? "检测到 0.61.0 · 运行中 · 路径已同步"
          : "未检测到 codex 可执行文件",
    });
    onRefreshed?.();
  };

  const handleUpgrade = () => {
    setUpgrading(true);
    toast.loading("正在下载并升级 Codex 0.62.0...", { id: "upgrade-codex" });
    setTimeout(() => {
      setUpgrading(false);
      toast.success("升级完成！已成功升级至 0.62.0", { id: "upgrade-codex" });
    }, 1500);
  };

  const handleRepair = () => {
    setRepairing(true);
    toast.loading("正在重新校验并修复 0.61.0 安装文件...", {
      id: "repair-codex",
    });
    setTimeout(() => {
      setRepairing(false);
      toast.success("修复完成！文件完整性校验 100% 通过", {
        id: "repair-codex",
      });
    }, 1200);
  };

  const handleRollback = () => {
    setRollingBack(true);
    toast.loading("正在回滚至 0.60.2...", { id: "rollback-codex" });
    setTimeout(() => {
      setRollingBack(false);
      toast.success("回滚完成！已切换至 0.60.2", { id: "rollback-codex" });
    }, 1200);
  };

  const handleUninstall = () => {
    setUninstallModalOpen(true);
    setDeleteConfigChecked(false);
  };

  const handleConfirmUninstall = () => {
    setUninstallModalOpen(false);
    toast.success("已完成 Codex CLI 卸载", {
      description: deleteConfigChecked
        ? "可执行文件、缓存与配置目录已彻底清理。"
        : "配置目录及 862 条会话已按默认策略妥善保留。",
    });
    // 卸载后进入未安装 / 安装中状态 (Frame 09C)
    setRuntimeMode("installing");
  };

  return (
    <div
      data-pencil-name={
        runtimeMode === "installed"
          ? "09A Codex 管理"
          : runtimeMode === "installing"
            ? "09C Codex 管理 · 未检测到 Codex CLI · 安装中"
            : "09D Codex 管理 · 安装失败"
      }
      className="box-border w-full h-full flex flex-col gap-[16px] p-[8px_24px_16px_24px] justify-start items-start bg-[#FDFDFE] dark:bg-[#171C21] overflow-y-auto"
    >
      {/* 页头 */}
      <div
        data-pencil-name="页头"
        className="box-border w-full h-fit shrink-0 flex flex-row gap-[12px] justify-start items-center"
      >
        <div
          data-pencil-name="标题区"
          className="box-border flex-1 h-fit flex flex-col gap-[2px] justify-start items-start"
        >
          <div
            data-pencil-name="标题行"
            className="box-border w-fit h-fit shrink-0 flex flex-row gap-[10px] justify-start items-center"
          >
            <h1
              data-pencil-name="标题"
              className="text-[28px]/[36px] m-0 p-0 text-[#12161C] dark:text-[#EEF0F3] font-bold text-left"
            >
              Codex 管理
            </h1>
          </div>
          <div
            data-pencil-name="说明"
            className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398] text-left"
          >
            Codex CLI 的安装、升级、修复、回滚与卸载 · 只改动本机
          </div>
        </div>

        {/* 状态机切换器（便捷验证 09A / 09C / 09D） */}
        <div className="flex items-center gap-[4px] bg-[#F2F4F6] dark:bg-[#23282D] p-[2px] rounded-[6px] text-[12px]">
          <button
            type="button"
            onClick={() => setRuntimeMode("installed")}
            className={`px-[8px] py-[3px] rounded-[4px] border-0 cursor-pointer transition-colors ${
              runtimeMode === "installed"
                ? "bg-[#FDFDFE] dark:bg-[#1A1E24] font-bold text-[#12161C] dark:text-[#EEF0F3] shadow-sm"
                : "bg-transparent text-[#646970] dark:text-[#8D9398] hover:text-[#12161C] dark:hover:text-[#EEF0F3]"
            }`}
          >
            已安装 (09A)
          </button>
          <button
            type="button"
            onClick={() => setRuntimeMode("installing")}
            className={`px-[8px] py-[3px] rounded-[4px] border-0 cursor-pointer transition-colors ${
              runtimeMode === "installing"
                ? "bg-[#FDFDFE] dark:bg-[#1A1E24] font-bold text-[#12161C] dark:text-[#EEF0F3] shadow-sm"
                : "bg-transparent text-[#646970] dark:text-[#8D9398] hover:text-[#12161C] dark:hover:text-[#EEF0F3]"
            }`}
          >
            安装中 (09C)
          </button>
          <button
            type="button"
            onClick={() => setRuntimeMode("failed")}
            className={`px-[8px] py-[3px] rounded-[4px] border-0 cursor-pointer transition-colors ${
              runtimeMode === "failed"
                ? "bg-[#FDFDFE] dark:bg-[#1A1E24] font-bold text-[#BE2323] dark:text-[#F85149] shadow-sm"
                : "bg-transparent text-[#646970] dark:text-[#8D9398] hover:text-[#12161C] dark:hover:text-[#EEF0F3]"
            }`}
          >
            安装失败 (09D)
          </button>
        </div>

        <div
          data-pencil-name="操作"
          className="box-border w-fit shrink-0 h-fit flex flex-row gap-[8px] justify-start items-center"
        >
          <button
            type="button"
            data-pencil-name="重新检测"
            onClick={handleRedetect}
            className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] px-[12px] justify-center items-center bg-[#FDFDFE] dark:bg-[#23282D] outline outline-1 outline-[#81878D] dark:outline-[#484E55] -outline-offset-1 rounded-[4px] cursor-pointer hover:bg-[#F2F4F6] dark:hover:bg-[#2C3238] transition-colors border-0"
          >
            <RotateCw
              size={14}
              className="text-[#12161C] dark:text-[#EEF0F3]"
            />
            <span className="text-[14px]/[20px] text-[#12161C] dark:text-[#EEF0F3] font-normal">
              重新检测
            </span>
          </button>
        </div>
      </div>

      {/* ============================================================ */}
      {/* 分支 1: Frame 45 (09A 常态已安装) */}
      {/* ============================================================ */}
      {runtimeMode === "installed" && (
        <>
          {/* 状态头 · Codex CLI (深色石墨外观) */}
          <div
            data-pencil-name="状态头 · Codex CLI"
            className="box-border w-full h-fit shrink-0 flex flex-row gap-[24px] p-[16px_16px_16px_24px] justify-start items-center bg-[#1A1E24] outline outline-1 outline-[#1A1E24] -outline-offset-1 rounded-[8px] overflow-hidden select-none"
          >
            <div
              data-pencil-name="标题区"
              className="box-border w-[200px] shrink-0 h-fit flex flex-col gap-[2px] justify-start items-start"
            >
              <span className="text-[13px]/[18px] text-[#94999E]">
                已安装 · 稳定版
              </span>
              <span className="text-[22px]/[25px] text-[#F5F7F9] font-mono font-bold">
                0.61.0
              </span>
              <span className="text-[13px]/[18px] text-[#B4B8BC]">
                运行中 · 2 个会话 · 14:10 检测
              </span>
            </div>

            {/* 路径条 3 节点 */}
            <div
              data-pencil-name="路径条"
              className="box-border flex-1 h-fit flex flex-row gap-0 justify-start items-start"
            >
              {/* 站 1: 安装包 */}
              <div className="box-border flex-1 h-fit flex flex-col gap-[10px] justify-start items-start">
                <div className="box-border w-full h-[12px] shrink-0 flex flex-row gap-0 justify-start items-center">
                  <div className="box-border w-[12px] h-[12px] bg-[#1A1E24] border-2 border-[#B4B8BC] rounded-full" />
                  <div className="box-border flex-1 h-[2px] bg-[#94999E]" />
                </div>
                <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[2px] pr-[12px] justify-start items-start">
                  <span className="text-[13px]/[18px] text-[#F5F7F9] font-bold">
                    安装包
                  </span>
                  <span className="text-[13px]/[18px] text-[#94999E]">
                    npm 全局 · @openai/codex
                  </span>
                </div>
              </div>

              {/* 站 2: 安装目录 */}
              <div className="box-border flex-1 h-fit flex flex-col gap-[10px] justify-start items-start">
                <div className="box-border w-full h-[12px] shrink-0 flex flex-row gap-0 justify-start items-center">
                  <div className="box-border w-[12px] h-[12px] bg-[#1A1E24] border-2 border-[#B4B8BC] rounded-full" />
                  <div className="box-border flex-1 h-[2px] bg-[#94999E]" />
                </div>
                <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[2px] pr-[12px] justify-start items-start">
                  <span className="text-[13px]/[18px] text-[#F5F7F9] font-bold">
                    安装目录
                  </span>
                  <span className="text-[13px]/[18px] text-[#94999E] font-mono">
                    Roaming\npm\codex.cmd
                  </span>
                </div>
              </div>

              {/* 站 3: 当前版本 */}
              <div className="box-border flex-1 h-fit flex flex-col gap-[10px] justify-start items-start">
                <div className="box-border w-full h-[12px] shrink-0 flex flex-row gap-0 justify-start items-center">
                  <div className="box-border w-[12px] h-[12px] bg-[#F5F7F9] border-2 border-[#F5F7F9] rounded-full" />
                </div>
                <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[2px] pr-[12px] justify-start items-start">
                  <span className="text-[13px]/[18px] text-[#F5F7F9] font-bold">
                    当前版本
                  </span>
                  <span className="text-[13px]/[18px] text-[#94999E]">
                    0.61.0 · 可升级到 0.62.0
                  </span>
                </div>
              </div>
            </div>

            {/* 问号帮助 */}
            <button
              type="button"
              aria-label="帮助信息"
              className="box-border w-[28px] shrink-0 h-[28px] flex items-center justify-center outline outline-1 outline-[#6F757B] -outline-offset-1 rounded-[4px] bg-transparent text-[#B4B8BC] border-0 cursor-pointer hover:bg-[#23282D]"
            >
              <HelpCircle size={16} />
            </button>
          </div>

          {/* 可升级卡片 */}
          <div
            data-pencil-name="可升级"
            className="box-border w-full h-fit shrink-0 flex flex-col gap-[12px] p-[16px] justify-start items-start bg-[#F2F4F6] dark:bg-[#1A1E24] outline outline-1 outline-[#DDE0E3] dark:outline-[#31363D] -outline-offset-1 rounded-[8px]"
          >
            <div className="box-border w-full h-fit shrink-0 flex flex-row gap-[8px] justify-start items-center">
              <div className="box-border w-fit shrink-0 h-[22px] flex flex-row gap-[4px] px-[8px] justify-start items-center bg-[#E8F1FD] dark:bg-[#1C3252] outline outline-1 outline-[#A8C6F2] dark:outline-[#2460B7] -outline-offset-1 rounded-full">
                <Info
                  size={12}
                  className="text-[#2460B7] dark:text-[#58A6FF]"
                />
                <span className="text-[12px]/[17px] text-[#2460B7] dark:text-[#58A6FF] font-bold">
                  新版本
                </span>
              </div>
              <span className="text-[18px]/[23px] text-[#12161C] dark:text-[#EEF0F3] font-mono font-bold">
                0.62.0
              </span>
              <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398]">
                9 月 25 日发布
              </span>
            </div>

            <div className="text-[15px]/[24px] text-[#484E55] dark:text-[#BABEC3]">
              修复 Responses 流式输出偶发中断；device-auth 登录新增超时参数。
            </div>

            <div className="box-border w-full h-fit shrink-0 flex flex-row gap-[6px] justify-start items-center">
              <AlertTriangle
                size={14}
                className="text-[#915C08] dark:text-[#D29922]"
              />
              <span className="text-[13px]/[18px] text-[#915C08] dark:text-[#D29922]">
                升级会重启 Codex，进行中的 2 个会话会中断
              </span>
            </div>

            <div className="box-border w-fit h-fit shrink-0 flex flex-row gap-[8px] justify-start items-center">
              <button
                type="button"
                disabled={upgrading}
                onClick={handleUpgrade}
                className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] px-[12px] justify-center items-center bg-[#006AA0] dark:bg-[#1F6FEB] rounded-[4px] border-0 cursor-pointer text-[#FDFDFE] hover:opacity-90 transition-opacity"
              >
                <ArrowUpCircle size={16} />
                <span className="text-[14px]/[20px] font-normal">
                  {upgrading ? "正在升级..." : "升级到 0.62.0"}
                </span>
              </button>

              <a
                href="https://github.com/openai/codex/releases"
                target="_blank"
                rel="noreferrer"
                className="box-border w-fit shrink-0 h-[28px] flex flex-row gap-[4px] px-[8px] justify-start items-center rounded-[4px] text-[#12161C] dark:text-[#EEF0F3] text-[13px] no-underline hover:bg-[#DDE0E3]/50 dark:hover:bg-[#31363D]"
              >
                <span>发布说明</span>
                <ExternalLink
                  size={14}
                  className="text-[#484E55] dark:text-[#8D9398]"
                />
              </a>
            </div>
          </div>

          {/* 维护操作 */}
          <div
            data-pencil-name="维护操作"
            className="box-border w-full h-fit shrink-0 flex flex-col gap-0 justify-start items-start"
          >
            <div className="text-[13px]/[18px] text-[#12161C] dark:text-[#EEF0F3] font-bold mb-[4px]">
              维护
            </div>

            {/* 修复安装 */}
            <div className="box-border w-full h-[64px] shrink-0 flex flex-row gap-[16px] py-[12px] justify-start items-center border-b border-[#DDE0E3] dark:border-[#31363D]">
              <Wrench
                size={18}
                className="text-[#484E55] dark:text-[#8D9398] shrink-0"
              />
              <div className="box-border flex-1 h-fit flex flex-col gap-[2px] justify-start items-start">
                <span className="text-[15px]/[21px] text-[#12161C] dark:text-[#EEF0F3]">
                  修复安装
                </span>
                <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398]">
                  重新下载 0.61.0 并覆盖可执行文件；配置、登录与会话不动。
                </span>
              </div>
              <button
                type="button"
                disabled={repairing}
                onClick={handleRepair}
                className="box-border w-fit shrink-0 h-[32px] px-[12px] flex items-center justify-center bg-[#FDFDFE] dark:bg-[#23282D] outline outline-1 outline-[#81878D] dark:outline-[#484E55] -outline-offset-1 rounded-[4px] border-0 cursor-pointer text-[14px]/[20px] text-[#12161C] dark:text-[#EEF0F3] hover:bg-[#F2F4F6] dark:hover:bg-[#2C3238]"
              >
                {repairing ? "修复中..." : "修复"}
              </button>
            </div>

            {/* 回滚 */}
            <div className="box-border w-full h-[64px] shrink-0 flex flex-row gap-[16px] py-[12px] justify-start items-center border-b border-[#DDE0E3] dark:border-[#31363D]">
              <RotateCcw
                size={18}
                className="text-[#484E55] dark:text-[#8D9398] shrink-0"
              />
              <div className="box-border flex-1 h-fit flex flex-col gap-[2px] justify-start items-start">
                <span className="text-[15px]/[21px] text-[#12161C] dark:text-[#EEF0F3]">
                  回滚
                </span>
                <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398]">
                  回到上一个版本 0.60.2（9 月 12
                  日安装，本机有缓存，无需联网）。
                </span>
              </div>
              <button
                type="button"
                disabled={rollingBack}
                onClick={handleRollback}
                className="box-border w-fit shrink-0 h-[32px] px-[12px] flex items-center justify-center bg-[#FDFDFE] dark:bg-[#23282D] outline outline-1 outline-[#81878D] dark:outline-[#484E55] -outline-offset-1 rounded-[4px] border-0 cursor-pointer text-[14px]/[20px] text-[#12161C] dark:text-[#EEF0F3] hover:bg-[#F2F4F6] dark:hover:bg-[#2C3238]"
              >
                {rollingBack ? "回滚中..." : "回滚到 0.60.2"}
              </button>
            </div>

            {/* 卸载 */}
            <div className="box-border w-full h-[64px] shrink-0 flex flex-row gap-[16px] py-[12px] justify-start items-center border-b border-[#DDE0E3] dark:border-[#31363D]">
              <Trash2
                size={18}
                className="text-[#BE2323] dark:text-[#F85149] shrink-0"
              />
              <div className="box-border flex-1 h-fit flex flex-col gap-[2px] justify-start items-start">
                <span className="text-[15px]/[21px] text-[#12161C] dark:text-[#EEF0F3]">
                  卸载
                </span>
                <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398]">
                  移除 Codex
                  CLI。配置目录里的配置、登录与会话默认保留，可在确认时选择一并删除。
                </span>
              </div>
              <button
                type="button"
                onClick={handleUninstall}
                className="box-border w-fit shrink-0 h-[32px] px-[12px] flex items-center justify-center bg-transparent border-0 cursor-pointer text-[14px]/[20px] text-[#BE2323] dark:text-[#F85149] hover:bg-[#BE2323]/10 rounded-[4px]"
              >
                卸载…
              </button>
            </div>
          </div>

          {/* 本机版本记录 */}
          <div
            data-pencil-name="版本记录"
            className="box-border w-full h-fit shrink-0 flex flex-col gap-0 justify-start items-start pb-[24px]"
          >
            <div className="text-[13px]/[18px] text-[#12161C] dark:text-[#EEF0F3] font-bold mb-[8px]">
              本机版本记录
            </div>

            {/* 0.61.0 */}
            <div className="box-border w-full h-[36px] shrink-0 flex flex-row gap-[16px] justify-start items-center border-b border-[#DDE0E3] dark:border-[#31363D]">
              <span className="text-[13px]/[18px] w-[72px] shrink-0 text-[#12161C] dark:text-[#EEF0F3] font-mono">
                0.61.0
              </span>
              <span className="text-[13px]/[18px] w-[180px] shrink-0 text-[#484E55] dark:text-[#BABEC3]">
                9 月 20 日 21:04 安装
              </span>
              <div className="box-border w-fit shrink-0 h-[20px] px-[8px] flex items-center justify-center bg-[#12161C] dark:bg-[#FDFDFE] rounded-full">
                <span className="text-[12px]/[17px] text-[#FDFDFE] dark:text-[#12161C] font-bold">
                  当前
                </span>
              </div>
              <span className="text-[13px]/[18px] flex-1 text-[#646970] dark:text-[#8D9398] text-right">
                从 0.60.2 升级
              </span>
            </div>

            {/* 0.60.2 */}
            <div className="box-border w-full h-[36px] shrink-0 flex flex-row gap-[16px] justify-start items-center border-b border-[#DDE0E3] dark:border-[#31363D]">
              <span className="text-[13px]/[18px] w-[72px] shrink-0 text-[#12161C] dark:text-[#EEF0F3] font-mono">
                0.60.2
              </span>
              <span className="text-[13px]/[18px] w-[180px] shrink-0 text-[#484E55] dark:text-[#BABEC3]">
                9 月 12 日 09:31 安装
              </span>
              <span className="text-[13px]/[18px] text-[#12161C] dark:text-[#EEF0F3]">
                可回滚
              </span>
              <span className="text-[13px]/[18px] flex-1 text-[#646970] dark:text-[#8D9398] text-right">
                本机缓存 38 MB
              </span>
            </div>

            {/* 0.59.1 */}
            <div className="box-border w-full h-[36px] shrink-0 flex flex-row gap-[16px] justify-start items-center border-b border-[#DDE0E3] dark:border-[#31363D]">
              <span className="text-[13px]/[18px] w-[72px] shrink-0 text-[#12161C] dark:text-[#EEF0F3] font-mono">
                0.59.1
              </span>
              <span className="text-[13px]/[18px] w-[180px] shrink-0 text-[#484E55] dark:text-[#BABEC3]">
                8 月 30 日 18:20 安装
              </span>
              <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398]">
                已清理
              </span>
              <span className="text-[13px]/[18px] flex-1 text-[#646970] dark:text-[#8D9398] text-right">
                缓存已删除，回滚需联网
              </span>
            </div>
          </div>
        </>
      )}

      {/* ============================================================ */}
      {/* 分支 2: Frame 46 (09C Codex 管理 · 未检测到 Codex CLI · 安装中) */}
      {/* ============================================================ */}
      {runtimeMode === "installing" && (
        <div className="box-border w-full flex flex-col gap-[24px]">
          {/* 状态头 · 安装中 (深色石墨外观) */}
          <div
            data-pencil-name="状态头 · 安装 Codex CLI"
            className="box-border w-full h-fit shrink-0 flex flex-row gap-[24px] p-[16px_16px_16px_24px] justify-start items-center bg-[#1A1E24] outline outline-1 outline-[#1A1E24] -outline-offset-1 rounded-[8px] overflow-hidden select-none"
          >
            <div className="box-border w-[200px] shrink-0 h-fit flex flex-col gap-[2px] justify-start items-start">
              <span className="text-[13px]/[18px] text-[#94999E]">
                Codex CLI · 14:24 检测
              </span>
              <span className="text-[22px]/[25px] text-[#58A6FF] font-bold">
                安装中
              </span>
              <span className="text-[13px]/[18px] text-[#B4B8BC]">
                PATH 里没有找到 codex
              </span>
            </div>

            {/* 路径条 3 节点 */}
            <div className="box-border flex-1 h-fit flex flex-row gap-0 justify-start items-start">
              {/* 站 1: 安装包 */}
              <div className="box-border flex-1 h-fit flex flex-col gap-[10px] justify-start items-start">
                <div className="box-border w-full h-[12px] shrink-0 flex flex-row gap-0 justify-start items-center">
                  <div className="box-border w-[12px] h-[12px] bg-[#58A6FF] border-2 border-[#58A6FF] rounded-full" />
                  <div className="box-border flex-1 h-[2px] bg-[#58A6FF]" />
                </div>
                <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[2px] pr-[12px] justify-start items-start">
                  <span className="text-[13px]/[18px] text-[#F5F7F9] font-bold">
                    安装包
                  </span>
                  <span className="text-[13px]/[18px] text-[#94999E]">
                    0.62.0 · 下载 24 / 38 MB
                  </span>
                </div>
              </div>

              {/* 站 2: 安装目录 */}
              <div className="box-border flex-1 h-fit flex flex-col gap-[10px] justify-start items-start">
                <div className="box-border w-full h-[12px] shrink-0 flex flex-row gap-0 justify-start items-center">
                  <div className="box-border w-[12px] h-[12px] bg-[#1A1E24] border-2 border-[#B4B8BC] rounded-full" />
                  <div className="box-border flex-1 h-[2px] bg-[#94999E]" />
                </div>
                <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[2px] pr-[12px] justify-start items-start">
                  <span className="text-[13px]/[18px] text-[#F5F7F9] font-bold">
                    安装目录
                  </span>
                  <span className="text-[13px]/[18px] text-[#94999E] font-mono">
                    Roaming\npm\
                  </span>
                </div>
              </div>

              {/* 站 3: 当前版本 */}
              <div className="box-border flex-1 h-fit flex flex-col gap-[10px] justify-start items-start">
                <div className="box-border w-full h-[12px] shrink-0 flex flex-row gap-0 justify-start items-center">
                  <div className="box-border w-[12px] h-[12px] bg-[#1A1E24] border-2 border-[#6F757B] rounded-full" />
                </div>
                <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[2px] pr-[12px] justify-start items-start">
                  <span className="text-[13px]/[18px] text-[#94999E] font-bold">
                    当前版本
                  </span>
                  <span className="text-[13px]/[18px] text-[#6F757B]">
                    准备中
                  </span>
                </div>
              </div>
            </div>

            {/* 帮助按钮 */}
            <button
              type="button"
              aria-label="帮助信息"
              className="box-border w-[28px] shrink-0 h-[28px] flex items-center justify-center outline outline-1 outline-[#6F757B] -outline-offset-1 rounded-[4px] bg-transparent text-[#B4B8BC] border-0 cursor-pointer hover:bg-[#23282D]"
            >
              <HelpCircle size={16} />
            </button>
          </div>

          {/* 分节 · 安装方式 */}
          <div className="box-border w-full flex flex-col gap-[8px]">
            <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398] font-bold">
              安装方式
            </span>
            {/* 选项 1: npm 全局 */}
            <div
              onClick={() => setInstallMethod("npm")}
              className={`box-border w-full h-[42px] rounded-[6px] border flex flex-row items-center gap-[12px] px-[12px] cursor-pointer transition-colors ${
                installMethod === "npm"
                  ? "bg-[#F2F4F6] dark:bg-[#1A1E24] border-[#006AA0] dark:border-[#58A6FF]"
                  : "bg-transparent border-[#DDE0E3] dark:border-[#31363D]"
              }`}
            >
              <div
                className={`w-[14px] h-[14px] rounded-full border-2 flex items-center justify-center ${
                  installMethod === "npm"
                    ? "border-[#006AA0] dark:border-[#58A6FF]"
                    : "border-[#81878D]"
                }`}
              >
                {installMethod === "npm" && (
                  <div className="w-[6px] h-[6px] rounded-full bg-[#006AA0] dark:bg-[#58A6FF]" />
                )}
              </div>
              <span className="text-[13px]/[18px] font-bold text-[#12161C] dark:text-[#EEF0F3]">
                npm 全局
              </span>
              <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398]">
                npm install -g @openai/codex@0.62.0 · 已检测到 Node.js 22.11.0
              </span>
            </div>

            {/* 选项 2: 独立安装包 */}
            <div
              onClick={() => setInstallMethod("standalone")}
              className={`box-border w-full h-[42px] rounded-[6px] border flex flex-row items-center gap-[12px] px-[12px] cursor-pointer transition-colors ${
                installMethod === "standalone"
                  ? "bg-[#F2F4F6] dark:bg-[#1A1E24] border-[#006AA0] dark:border-[#58A6FF]"
                  : "bg-transparent border-[#DDE0E3] dark:border-[#31363D]"
              }`}
            >
              <div
                className={`w-[14px] h-[14px] rounded-full border-2 flex items-center justify-center ${
                  installMethod === "standalone"
                    ? "border-[#006AA0] dark:border-[#58A6FF]"
                    : "border-[#81878D]"
                }`}
              >
                {installMethod === "standalone" && (
                  <div className="w-[6px] h-[6px] rounded-full bg-[#006AA0] dark:bg-[#58A6FF]" />
                )}
              </div>
              <span className="text-[13px]/[18px] font-bold text-[#12161C] dark:text-[#EEF0F3]">
                独立安装包
              </span>
              <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398]">
                下载官方 Windows 安装包，不依赖 Node.js，可以自选安装位置
              </span>
            </div>
          </div>

          {/* 分节 · 安装位置 */}
          <div className="box-border w-full flex flex-col gap-[8px]">
            <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398] font-bold">
              安装位置
            </span>
            <div className="flex flex-row items-center gap-[12px]">
              <span className="text-[13px]/[18px] font-mono text-[#12161C] dark:text-[#EEF0F3]">
                C:\Users\lin\AppData\Roaming\npm\codex.cmd
              </span>
              <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398]">
                由 npm 全局目录决定；只写入这里，不改动 C:\Users\lin\.codex\
              </span>
            </div>
          </div>

          {/* 分节 · 进度 */}
          <div className="box-border w-full flex flex-col gap-[8px]">
            <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398] font-bold">
              进度
            </span>

            {/* 状态行 */}
            <div className="flex flex-row items-center justify-between">
              <div className="flex flex-row items-center gap-[8px]">
                <LoaderCircle
                  size={16}
                  className="text-[#006AA0] dark:text-[#58A6FF] animate-spin"
                />
                <span className="text-[15px]/[21px] text-[#12161C] dark:text-[#EEF0F3]">
                  正在下载 @openai/codex 0.62.0 · 24 / 38 MB
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  toast.info("已取消安装");
                  setRuntimeMode("failed");
                }}
                className="px-[12px] h-[28px] border border-[#DDE0E3] dark:border-[#31363D] bg-transparent text-[#646970] dark:text-[#8D9398] text-[13px] rounded-[4px] cursor-pointer hover:bg-[#F2F4F6] dark:hover:bg-[#23282D]"
              >
                取消安装
              </button>
            </div>

            {/* 进度条 (24 / 38 MB ≈ 63%) */}
            <div className="w-full h-[4px] bg-[#E2E4E8] dark:bg-[#31363D] rounded-full overflow-hidden">
              <div
                className="h-full bg-[#006AA0] dark:bg-[#58A6FF] rounded-full transition-all duration-300"
                style={{ width: "63%" }}
              />
            </div>

            {/* 步骤条 */}
            <div className="flex flex-row gap-[24px] pt-[4px]">
              <div className="flex items-center gap-[6px]">
                <LoaderCircle
                  size={14}
                  className="text-[#006AA0] dark:text-[#58A6FF] animate-spin"
                />
                <span className="text-[13px]/[18px] text-[#12161C] dark:text-[#EEF0F3] font-medium">
                  1 下载安装包
                </span>
              </div>
              <div className="flex items-center gap-[6px]">
                <Circle size={14} className="text-[#81878D]" />
                <span className="text-[13px]/[18px] text-[#81878D]">
                  2 写入 Roaming\npm\
                </span>
              </div>
              <div className="flex items-center gap-[6px]">
                <Circle size={14} className="text-[#81878D]" />
                <span className="text-[13px]/[18px] text-[#81878D]">
                  3 检测版本
                </span>
              </div>
            </div>
          </div>

          {/* 分节 · 装好之后 */}
          <div className="box-border w-full flex flex-col gap-[8px] pt-[8px] border-t border-[#DDE0E3] dark:border-[#31363D]">
            <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398] font-bold">
              装好之后
            </span>
            <div className="text-[14px]/[22px] text-[#12161C] dark:text-[#EEF0F3] max-w-[560px]">
              配置目录 C:\Users\lin\.codex\ 保留着，config.toml 和 862
              条会话都还在。Chimera++ 里的 9 条线路、3 个官方账号也不受影响。
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* 分支 3: Frame 47 (09D Codex 管理 · 安装失败) */}
      {/* ============================================================ */}
      {runtimeMode === "failed" && (
        <div className="box-border w-full flex flex-col gap-[24px]">
          {/* 状态头 · 安装失败 (深色石墨外观) */}
          <div
            data-pencil-name="状态头 · 安装失败"
            className="box-border w-full h-fit shrink-0 flex flex-row gap-[24px] p-[16px_16px_16px_24px] justify-start items-center bg-[#1A1E24] outline outline-1 outline-[#1A1E24] -outline-offset-1 rounded-[8px] overflow-hidden select-none"
          >
            <div className="box-border w-[200px] shrink-0 h-fit flex flex-col gap-[2px] justify-start items-start">
              <span className="text-[13px]/[18px] text-[#94999E]">
                Codex CLI · 14:26
              </span>
              <span className="text-[22px]/[25px] text-[#BE2323] dark:text-[#F85149] font-bold">
                安装失败
              </span>
              <span className="text-[13px]/[18px] text-[#B4B8BC]">
                没有写入任何文件
              </span>
            </div>

            {/* 路径条 3 节点 */}
            <div className="box-border flex-1 h-fit flex flex-row gap-0 justify-start items-start">
              {/* 站 1: 安装包 */}
              <div className="box-border flex-1 h-fit flex flex-col gap-[10px] justify-start items-start">
                <div className="box-border w-full h-[12px] shrink-0 flex flex-row gap-0 justify-start items-center">
                  <div className="box-border w-[12px] h-[12px] bg-[#BE2323] border-2 border-[#BE2323] rounded-full" />
                  <div className="box-border flex-1 h-[2px] bg-[#81878D]" />
                </div>
                <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[2px] pr-[12px] justify-start items-start">
                  <span className="text-[13px]/[18px] text-[#BE2323] dark:text-[#F85149] font-bold">
                    安装包
                  </span>
                  <span className="text-[13px]/[18px] text-[#94999E]">
                    下载超时 · 已清理 24 MB
                  </span>
                </div>
              </div>

              {/* 站 2: 安装目录 */}
              <div className="box-border flex-1 h-fit flex flex-col gap-[10px] justify-start items-start">
                <div className="box-border w-full h-[12px] shrink-0 flex flex-row gap-0 justify-start items-center">
                  <div className="box-border w-[12px] h-[12px] bg-[#1A1E24] border-2 border-[#6F757B] rounded-full" />
                  <div className="box-border flex-1 h-[2px] bg-[#6F757B]" />
                </div>
                <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[2px] pr-[12px] justify-start items-start">
                  <span className="text-[13px]/[18px] text-[#94999E] font-bold">
                    安装目录
                  </span>
                  <span className="text-[13px]/[18px] text-[#6F757B] font-mono">
                    Roaming\npm\
                  </span>
                </div>
              </div>

              {/* 站 3: 当前版本 */}
              <div className="box-border flex-1 h-fit flex flex-col gap-[10px] justify-start items-start">
                <div className="box-border w-full h-[12px] shrink-0 flex flex-row gap-0 justify-start items-center">
                  <div className="box-border w-[12px] h-[12px] bg-[#1A1E24] border-2 border-[#6F757B] rounded-full" />
                </div>
                <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[2px] pr-[12px] justify-start items-start">
                  <span className="text-[13px]/[18px] text-[#94999E] font-bold">
                    当前版本
                  </span>
                  <span className="text-[13px]/[18px] text-[#6F757B]">
                    仍未安装
                  </span>
                </div>
              </div>
            </div>

            {/* 帮助按钮 */}
            <button
              type="button"
              aria-label="帮助信息"
              className="box-border w-[28px] shrink-0 h-[28px] flex items-center justify-center outline outline-1 outline-[#6F757B] -outline-offset-1 rounded-[4px] bg-transparent text-[#B4B8BC] border-0 cursor-pointer hover:bg-[#23282D]"
            >
              <HelpCircle size={16} />
            </button>
          </div>

          {/* 分节 · 安装方式 */}
          <div className="box-border w-full flex flex-col gap-[8px]">
            <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398] font-bold">
              安装方式
            </span>
            <div
              onClick={() => setInstallMethod("npm")}
              className={`box-border w-full h-[42px] rounded-[6px] border flex flex-row items-center gap-[12px] px-[12px] cursor-pointer transition-colors ${
                installMethod === "npm"
                  ? "bg-[#F2F4F6] dark:bg-[#1A1E24] border-[#81878D]"
                  : "bg-transparent border-[#DDE0E3] dark:border-[#31363D]"
              }`}
            >
              <div
                className={`w-[14px] h-[14px] rounded-full border-2 flex items-center justify-center ${
                  installMethod === "npm"
                    ? "border-[#BE2323]"
                    : "border-[#81878D]"
                }`}
              >
                {installMethod === "npm" && (
                  <div className="w-[6px] h-[6px] rounded-full bg-[#BE2323]" />
                )}
              </div>
              <span className="text-[13px]/[18px] font-bold text-[#12161C] dark:text-[#EEF0F3]">
                npm 全局
              </span>
              <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398]">
                npm install -g @openai/codex@0.62.0 · 已检测到 Node.js 22.11.0
              </span>
            </div>

            <div
              onClick={() => setInstallMethod("standalone")}
              className={`box-border w-full h-[42px] rounded-[6px] border flex flex-row items-center gap-[12px] px-[12px] cursor-pointer transition-colors ${
                installMethod === "standalone"
                  ? "bg-[#F2F4F6] dark:bg-[#1A1E24] border-[#006AA0] dark:border-[#58A6FF]"
                  : "bg-transparent border-[#DDE0E3] dark:border-[#31363D]"
              }`}
            >
              <div
                className={`w-[14px] h-[14px] rounded-full border-2 flex items-center justify-center ${
                  installMethod === "standalone"
                    ? "border-[#006AA0] dark:border-[#58A6FF]"
                    : "border-[#81878D]"
                }`}
              >
                {installMethod === "standalone" && (
                  <div className="w-[6px] h-[6px] rounded-full bg-[#006AA0] dark:bg-[#58A6FF]" />
                )}
              </div>
              <span className="text-[13px]/[18px] font-bold text-[#12161C] dark:text-[#EEF0F3]">
                独立安装包
              </span>
              <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398]">
                下载官方 Windows 安装包，不依赖 Node.js，可以自选安装位置
              </span>
            </div>
          </div>

          {/* 分节 · 安装位置 */}
          <div className="box-border w-full flex flex-col gap-[8px]">
            <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398] font-bold">
              安装位置
            </span>
            <div className="flex flex-row items-center gap-[12px]">
              <span className="text-[13px]/[18px] font-mono text-[#12161C] dark:text-[#EEF0F3]">
                C:\Users\lin\AppData\Roaming\npm\codex.cmd
              </span>
              <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398]">
                由 npm 全局目录决定；只写入这里，不改动 C:\Users\lin\.codex\
              </span>
            </div>
          </div>

          {/* 分节 · 失败原因 */}
          <div className="box-border w-full flex flex-col gap-[8px]">
            <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398] font-bold">
              失败原因
            </span>

            {/* 错误卡片 (左侧 3px 红色边框) */}
            <div className="box-border w-full p-[16px] border-l-[3px] border-l-[#BE2323] bg-[#FDF2F2] dark:bg-[#2A1618] rounded-r-[6px] flex flex-row gap-[12px] items-start">
              <XCircle
                size={20}
                className="text-[#BE2323] dark:text-[#F85149] shrink-0 mt-[2px]"
              />
              <div className="flex-1 flex flex-col gap-[6px]">
                <div className="text-[15px]/[21px] font-bold text-[#12161C] dark:text-[#EEF0F3]">
                  下载超时：registry.npmjs.org 30 秒没有响应
                </div>
                <div className="text-[13px]/[18px] font-mono text-[#646970] dark:text-[#8D9398]">
                  npm ERR! code ETIMEDOUT
                </div>
                <div className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398]">
                  没有写入任何文件，已下载的 24 MB 临时文件已清理。
                </div>

                {/* 恢复操作按钮组 */}
                <div className="flex flex-row flex-wrap items-center gap-[8px] pt-[8px]">
                  <button
                    type="button"
                    onClick={() => {
                      toast.info("正在重试 npm 全局安装...");
                      setRuntimeMode("installing");
                    }}
                    className="box-border h-[32px] px-[12px] bg-[#BE2323] hover:bg-[#a51d1d] text-[#FDFDFE] text-[13px] font-medium rounded-[4px] border-0 cursor-pointer flex items-center gap-[6px]"
                  >
                    <RotateCw size={14} />
                    <span>重试</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      toast.info("改用 npmmirror 镜像重试...");
                      setRuntimeMode("installing");
                    }}
                    className="box-border h-[32px] px-[12px] bg-[#FDFDFE] dark:bg-[#1A1E24] outline outline-1 outline-[#81878D] dark:outline-[#484E55] -outline-offset-1 text-[#12161C] dark:text-[#EEF0F3] text-[13px] rounded-[4px] border-0 cursor-pointer hover:bg-[#F2F4F6] dark:hover:bg-[#23282D] flex items-center gap-[6px]"
                  >
                    <Globe size={14} />
                    <span>改用 npmmirror 镜像重试</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setInstallMethod("standalone");
                      toast.info("已切换至独立安装包方式");
                      setRuntimeMode("installing");
                    }}
                    className="box-border h-[32px] px-[12px] bg-[#FDFDFE] dark:bg-[#1A1E24] outline outline-1 outline-[#81878D] dark:outline-[#484E55] -outline-offset-1 text-[#12161C] dark:text-[#EEF0F3] text-[13px] rounded-[4px] border-0 cursor-pointer hover:bg-[#F2F4F6] dark:hover:bg-[#23282D] flex items-center gap-[6px]"
                  >
                    <Package size={14} />
                    <span>改用独立安装包</span>
                  </button>
                </div>

                {/* 日志路径行 */}
                <div className="flex flex-row items-center gap-[8px] pt-[8px] text-[12px]">
                  <span className="text-[#81878D]">日志</span>
                  <span className="font-mono text-[#646970] dark:text-[#8D9398] select-all">
                    C:\Users\lin\AppData\Roaming\Chimera\logs\codex-install-2026-09-27_1424.log
                  </span>
                  <button
                    type="button"
                    onClick={() => toast.info("已打开安装日志")}
                    className="h-[22px] px-[6px] border border-[#81878D] bg-transparent text-[#12161C] dark:text-[#EEF0F3] rounded-[3px] cursor-pointer flex items-center gap-[4px]"
                  >
                    <span>打开</span>
                    <ExternalLink size={10} />
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* 分节 · 你的数据 */}
          <div className="box-border w-full flex flex-col gap-[8px] pt-[8px] border-t border-[#DDE0E3] dark:border-[#31363D]">
            <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398] font-bold">
              你的数据
            </span>
            <div className="text-[14px]/[22px] text-[#12161C] dark:text-[#EEF0F3] max-w-[560px]">
              配置目录 C:\Users\lin\.codex\ 保留着，config.toml 和 862
              条会话都还在。Chimera++ 里的 9 条线路、3 个官方账号也不受影响。
            </div>
          </div>
        </div>
      )}

      {/* Frame 13D / 13DD / 13D2 卸载 Codex CLI 破坏性确认弹窗 */}
      {uninstallModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#12161C66]">
          <div className="box-border w-[560px] h-fit bg-[#FDFDFE] dark:bg-[#1A1E24] shadow-[0px_12px_28px_#12161C1F] rounded-[8px] p-[24px] flex flex-col gap-[16px]">
            {/* 弹窗头 */}
            <div className="flex flex-row justify-between items-center border-b border-[#DDE0E3] dark:border-[#31363D] pb-[12px]">
              <div className="flex flex-row items-center gap-[8px] text-[#BE2323]">
                <AlertTriangle size={20} />
                <h3 className="m-0 text-[18px]/[23px] text-[#12161C] dark:text-[#EEF0F3] font-bold">
                  卸载 Codex CLI 0.61.0？
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setUninstallModalOpen(false)}
                className="w-[28px] h-[28px] flex items-center justify-center border-0 bg-transparent text-[#646970] hover:bg-[#F2F4F6] rounded-[4px] cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            {/* 正文说明 */}
            <div className="text-[13px]/[18px] text-[#484E55] dark:text-[#BABEC3]">
              {deleteConfigChecked
                ? "会移除 Codex CLI 和它的配置目录，正在运行的 2 个会话会被结束。Codex CLI 之后可以在这一页重新安装，会话记录则无法找回。"
                : "会移除 npm 全局安装的 Codex CLI，正在运行的 2 个会话会被结束。配置目录默认保留，之后可以在这一页重新安装。"}
            </div>

            {/* 文件影响面板 */}
            <div className="box-border w-full p-[12px] rounded-[6px] bg-[#F5F7F9] dark:bg-[#171C21] border border-[#DDE0E3] dark:border-[#31363D] flex flex-col gap-[8px] text-[13px]">
              <div className="flex flex-col gap-[2px]">
                <span className="text-[#BE2323] font-bold">将删除：</span>
                <span className="font-mono text-[#12161C] dark:text-[#EEF0F3]">
                  C:\Users\lin\AppData\Roaming\npm\codex.cmd
                </span>
                <span className="text-[12px] text-[#646970]">
                  以及 node_modules\@openai\codex\，共 41 MB
                </span>
              </div>
              <div className="h-[1px] bg-[#DDE0E3] dark:bg-[#31363D] my-[2px]" />
              <div className="flex flex-col gap-[2px]">
                <span className="text-[#05773B] font-bold">
                  {deleteConfigChecked ? "仍然保留：" : "默认保留："}
                </span>
                <span className="font-mono text-[#12161C] dark:text-[#EEF0F3]">
                  {deleteConfigChecked
                    ? "C:\\Users\\lin\\AppData\\Roaming\\Chimera\\"
                    : "C:\\Users\\lin\\.codex\\"}
                </span>
                <span className="text-[12px] text-[#646970]">
                  {deleteConfigChecked
                    ? "线路、3 个官方账号、备份（Chimera++ 自己的数据）"
                    : "config.toml、auth.json（当前登录）、862 条会话记录"}
                </span>
              </div>
            </div>

            {/* 13D2 勾选开关 */}
            <label className="flex flex-row items-center gap-[8px] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={deleteConfigChecked}
                onChange={(e) => setDeleteConfigChecked(e.target.checked)}
                className="rounded"
              />
              <span
                className={`text-[13px] ${deleteConfigChecked ? "text-[#BE2323] font-bold" : "text-[#484E55] dark:text-[#BABEC3]"}`}
              >
                同时删除用户配置目录与 862 条会话
              </span>
            </label>

            {/* 底部按钮 */}
            <div className="flex flex-row justify-end gap-[8px] pt-[8px] border-t border-[#DDE0E3] dark:border-[#31363D]">
              <button
                type="button"
                onClick={() => setUninstallModalOpen(false)}
                className="px-[12px] h-[32px] rounded-[4px] border border-[#81878D] bg-transparent text-[#12161C] dark:text-[#EEF0F3] text-[13px] cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleConfirmUninstall}
                className={`px-[16px] h-[32px] rounded-[4px] border-0 text-[13px] font-bold cursor-pointer transition-colors ${
                  deleteConfigChecked
                    ? "bg-[#BE2323] hover:bg-[#a51d1d] text-[#FDFDFE]"
                    : "bg-[#006AA0] hover:bg-[#005a88] text-[#FDFDFE]"
                }`}
              >
                {deleteConfigChecked ? "确认彻底删除" : "卸载 Codex CLI"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default RuntimeView;
