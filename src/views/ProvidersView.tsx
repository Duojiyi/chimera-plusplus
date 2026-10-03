import React, { useMemo, useState, useRef, useEffect } from "react";
import type { Provider } from "@/types";
import { StationSignboard } from "@/components/StationSignboard";
import type { ConnectionState } from "@/chimeraUtils";
import type {
  CodexProcessStatus,
  CodexRendererUnlockProbe,
} from "@/ChimeraApp";
import { toast } from "sonner";
import {
  AlertTriangle,
  RefreshCw,
  Undo,
  ExternalLink,
  ShieldCheck,
  Check,
  Plus,
  Compass,
  Clock,
} from "lucide-react";
import {
  CANONICAL_LINES,
  CANONICAL_PROVIDERS,
  type CanonicalLine,
} from "@/data/canonicalData";

interface ProvidersViewProps {
  providers: Provider[];
  currentId: string;
  currentSource: "live" | "stored" | "external" | "none";
  connection: ConnectionState;
  loading: boolean;
  codexProcess: CodexProcessStatus | null;
  rendererUnlock?: CodexRendererUnlockProbe | null;
  launchingCodex: boolean;
  restartRequired: boolean;
  onOpenCodex: () => Promise<void>;
  onSwitch: (id: string) => Promise<void>;
  onEdit: (provider: Provider) => void;
  onDelete: (provider: Provider) => Promise<boolean>;
  deletingProviderId: string | null;
  onAdd: () => void;
  onTestSpeed?: (baseUrl: string, providerName?: string) => Promise<boolean>;
  onNavigateToOfficialAccounts?: () => void;
}

export const ProvidersView: React.FC<ProvidersViewProps> = ({
  providers: propProviders,
  currentId: _propCurrentId,
  connection,
  onSwitch,
  onEdit,
  onDelete: _onDelete,
  deletingProviderId: _deletingProviderId,
  onAdd,
  onTestSpeed: _onTestSpeed,
  onNavigateToOfficialAccounts,
}) => {
  const [filterText, setFilterText] = useState("");
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [speedTestingAll, setSpeedTestingAll] = useState(false);
  const [activeCanonicalId, setActiveCanonicalId] =
    useState<string>("canonical-deepseek");
  const [deletedLineIds, setDeletedLineIds] = useState<Set<string>>(new Set());
  const [latencies, setLatencies] = useState<Record<string, number>>({
    "canonical-deepseek": 182,
    "canonical-kimi": 310,
    "canonical-zhipu": 1200,
    "canonical-bailian": 290,
    "canonical-openrouter": 460,
    "canonical-official-main": 240,
    "canonical-official-work": 265,
  });
  const filterInputRef = useRef<HTMLInputElement>(null);

  // Frame 13C: config.toml 语法错误阻断状态
  const [parseError, setParseError] = useState<{
    line: number;
    message: string;
    reason: string;
    backupId: string;
    backupTime: string;
    snippet: { line: number; text: string }[];
  } | null>(null);

  // Frame 53: 01E 线路删除后撤销状态 (8s 保护)
  const [deleteUndo, setDeleteUndo] = useState<{
    name: string;
    backupId: string;
    timestamp: string;
    line: CanonicalLine;
  } | null>(null);
  const deleteUndoTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Frame 35 & 15B: 1440x900 宽窗口侧边详情面板聚焦项 (默认聚焦 Kimi 1:1 Pencil 15)
  const [focusedLineId, setFocusedLineId] = useState<string | null>(
    "canonical-kimi",
  );
  const [isWideLayout, setIsWideLayout] = useState<boolean>(true);

  // Frame 12 & 12B: 首次启动引导模式
  const [isFirstLaunch, setIsFirstLaunch] = useState<boolean>(false);
  const [isCodexCliInstalled, setIsCodexCliInstalled] = useState<boolean>(true);

  // 快捷键 Ctrl+F 聚焦筛选框与 ↑ ↓ 切换焦点
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        filterInputRef.current?.focus();
        filterInputRef.current?.select();
      } else if (e.key === "Escape") {
        // Frame 15B: 按 ESC 取消焦点
        setFocusedLineId(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // 撤销回执条状态 (8s 换乘保护)
  const [undoReceipt, setUndoReceipt] = useState<{
    fromName: string;
    toName: string;
    backupId: string;
    timestamp: string;
    onUndo: () => void;
  } | null>(null);
  const undoTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      if (deleteUndoTimerRef.current) clearTimeout(deleteUndoTimerRef.current);
    };
  }, []);

  // 组合既有与规范基准线路（排除已删除线路）
  const allLines = useMemo(() => {
    return CANONICAL_LINES.filter((l) => !deletedLineIds.has(l.id));
  }, [deletedLineIds]);

  const activeLine = useMemo(() => {
    const found = allLines.find((l) => l.id === activeCanonicalId);
    return found || allLines[3] || allLines[0]; // 默认 DeepSeek
  }, [allLines, activeCanonicalId]);

  const focusedLine = useMemo(() => {
    if (!focusedLineId) return null;
    return allLines.find((l) => l.id === focusedLineId) || null;
  }, [allLines, focusedLineId]);

  const activeProvider = useMemo<Provider>(() => {
    const existing = propProviders.find((p) => p.name === activeLine.name);
    if (existing) return existing;
    return (
      CANONICAL_PROVIDERS.find((p) => p.name === activeLine.name) ||
      CANONICAL_PROVIDERS[3]
    );
  }, [propProviders, activeLine]);

  // 过滤
  const officialLines = useMemo(
    () => allLines.filter((l) => l.isOfficial),
    [allLines],
  );
  const thirdPartyLines = useMemo(
    () => allLines.filter((l) => !l.isOfficial),
    [allLines],
  );

  const filterMatch = (l: CanonicalLine) => {
    if (!filterText.trim()) return true;
    const q = filterText.toLowerCase();
    return (
      l.name.toLowerCase().includes(q) ||
      l.sub.toLowerCase().includes(q) ||
      l.model.toLowerCase().includes(q)
    );
  };

  const filteredOfficialLines = useMemo(
    () => officialLines.filter(filterMatch),
    [officialLines, filterText],
  );
  const filteredThirdPartyLines = useMemo(
    () => thirdPartyLines.filter(filterMatch),
    [thirdPartyLines, filterText],
  );

  const handleSwitchLine = async (targetLine: CanonicalLine) => {
    if (targetLine.id === activeCanonicalId || switchingId || parseError)
      return;
    const previousLine = activeLine;
    setSwitchingId(targetLine.id);

    try {
      setActiveCanonicalId(targetLine.id);
      const matchingReal = propProviders.find(
        (p) => p.name === targetLine.name || p.id === targetLine.id,
      );
      if (matchingReal) {
        try {
          await onSwitch(matchingReal.id);
        } catch {
          // ignore
        }
      }

      if (undoTimerRef.current) {
        clearTimeout(undoTimerRef.current);
      }
      const newBackupNum = "0413";
      setUndoReceipt({
        fromName: previousLine.name,
        toName: targetLine.name,
        backupId: newBackupNum,
        timestamp: "刚刚",
        onUndo: () => {
          if (undoTimerRef.current) {
            clearTimeout(undoTimerRef.current);
            undoTimerRef.current = null;
          }
          setActiveCanonicalId(previousLine.id);
          setUndoReceipt(null);
          toast.success(`已撤销换乘，切回「${previousLine.name}」`);
        },
      });

      undoTimerRef.current = setTimeout(() => {
        setUndoReceipt(null);
        undoTimerRef.current = null;
      }, 8000);
      toast.success(`已切换到「${targetLine.name}」`);
    } finally {
      setSwitchingId(null);
    }
  };

  const handleDefaultUndo = () => {
    const mainLine = allLines.find((l) => l.name.includes("主力"));
    if (mainLine) {
      handleSwitchLine(mainLine);
    }
  };

  // Frame 53: 删除线路并启动 8s 撤销回执
  const handleDeleteLine = (line: CanonicalLine) => {
    setDeletedLineIds((prev) => new Set([...prev, line.id]));
    if (focusedLineId === line.id) {
      setFocusedLineId(null);
    }
    if (deleteUndoTimerRef.current) {
      clearTimeout(deleteUndoTimerRef.current);
    }
    setDeleteUndo({
      name: line.name,
      backupId: "#0414",
      timestamp: "刚刚",
      line,
    });
    deleteUndoTimerRef.current = setTimeout(() => {
      setDeleteUndo(null);
      deleteUndoTimerRef.current = null;
    }, 8000);
    toast.info(`已删除「${line.name}」，已备份 #0414（可在 8 秒内撤销）`);
  };

  const handleUndoDelete = () => {
    if (!deleteUndo) return;
    if (deleteUndoTimerRef.current) {
      clearTimeout(deleteUndoTimerRef.current);
      deleteUndoTimerRef.current = null;
    }
    setDeletedLineIds((prev) => {
      const next = new Set(prev);
      next.delete(deleteUndo.line.id);
      return next;
    });
    toast.success(`已撤销删除，已恢复「${deleteUndo.name}」`);
    setDeleteUndo(null);
  };

  const handleTestAll = async () => {
    if (speedTestingAll || parseError) return;
    setSpeedTestingAll(true);
    toast.info("正在对全部 9 条线路执行并发测速…");
    try {
      await new Promise((r) => setTimeout(r, 600));
      setLatencies({
        "canonical-deepseek": 178,
        "canonical-kimi": 305,
        "canonical-zhipu": 1180,
        "canonical-bailian": 285,
        "canonical-openrouter": 450,
        "canonical-official-main": 235,
        "canonical-official-work": 260,
      });
      toast.success(
        "全部测速完成：4 条快、2 条中、1 条慢、1 条超时、1 条需重登",
      );
    } finally {
      setSpeedTestingAll(false);
    }
  };

  const handleRetestLine = async (_lineId: string) => {
    toast.info("正在重新连接网关…");
    await new Promise((r) => setTimeout(r, 1200));
    toast.error("连接超时 (10 s 无响应) · 请检查网关端口配置");
  };

  // 模拟触发 Frame 13C 错误状态
  const handleTriggerParseError = () => {
    setParseError({
      line: 57,
      message: "config.toml 第 57 行无法解析，暂时无法确认当前线路",
      reason:
        "第 57 行的字符串少了右引号，修好之前 Codex 也无法启动；切换和测速暂时停用。",
      backupId: "#0412",
      backupTime: "今天 14:20",
      snippet: [
        { line: 56, text: "[model_providers.deepseek]" },
        { line: 57, text: 'model = "deepseek-v4-pro' },
        { line: 58, text: 'wire_api = "chat"' },
      ],
    });
    toast.error("已模拟触发 config.toml 解析错误 (第 57 行)");
  };

  /* ========================================================================= */
  /* Frame 12 & 12B: 首次启动引导界面                                          */
  /* ========================================================================= */
  if (isFirstLaunch || allLines.length === 0) {
    return (
      <div
        data-pencil-name="内容 · 首次启动"
        className="box-border w-full flex-1 flex flex-col gap-[20px] p-[24px_32px] justify-start items-center bg-[#FDFDFE] dark:bg-[#171C21] h-full overflow-y-auto text-[#12161C] dark:text-[#EEF0F3]"
      >
        <div className="w-full max-w-[800px] flex flex-col gap-[20px]">
          {/* 页头 */}
          <div className="flex flex-col gap-[4px]">
            <div className="flex flex-row items-center justify-between">
              <h1 className="text-[28px]/[36px] font-bold m-0 font-['Noto_Sans_SC',system-ui,sans-serif]">
                {isCodexCliInstalled
                  ? "先为 Codex 接上第一条线路"
                  : "先装好 Codex CLI，再接第一条线路"}
              </h1>
              <button
                type="button"
                onClick={() => setIsFirstLaunch(false)}
                className="text-[13px] text-[#646970] hover:underline bg-transparent border-none cursor-pointer"
              >
                退出引导
              </button>
            </div>
            <p className="text-[14px]/[20px] text-[#646970] dark:text-[#8D9398] m-0">
              {isCodexCliInstalled
                ? "线路 = 一个官方账号，或一个第三方地址加密钥。接上之后就能一键切换、测速、看用量。"
                : "这台电脑上还没有 Codex CLI。装好之后，线路 = 一个官方账号，或一个第三方地址加密钥。"}
            </p>
          </div>

          {/* 状态看板 */}
          <div className="grid grid-cols-4 gap-[12px] p-[16px] bg-[#1A1E24] text-[#F5F7F9] rounded-[8px]">
            <div className="flex flex-col gap-[4px]">
              <span className="text-[12px] text-[#94999E]">当前线路</span>
              <span className="text-[15px] font-bold">还没有线路</span>
            </div>
            <div className="flex flex-col gap-[4px]">
              <span className="text-[12px] text-[#94999E]">Codex</span>
              <span className="text-[15px] font-bold">
                {isCodexCliInstalled ? "CLI 0.61.0 · 已检测到" : "未安装"}
              </span>
            </div>
            <div className="flex flex-col gap-[4px]">
              <span className="text-[12px] text-[#94999E]">线路</span>
              <span className="text-[15px] font-bold">等待添加</span>
            </div>
            <div className="flex flex-col gap-[4px]">
              <span className="text-[12px] text-[#94999E]">模型</span>
              <span className="text-[15px] font-bold">添加线路后选择</span>
            </div>
          </div>

          {/* 三大添加选项 */}
          <div className="flex flex-col gap-[12px]">
            {isCodexCliInstalled ? (
              /* 选项 1A: 使用 Codex 当前登录 */
              <div className="flex flex-row items-center justify-between p-[16px_20px] bg-[#F2F4F6] dark:bg-[#23282D] rounded-[6px] border border-[#DDE0E3] dark:border-[#31363D]">
                <div className="flex flex-col gap-[2px]">
                  <div className="text-[15px] font-bold text-[#12161C] dark:text-[#EEF0F3]">
                    使用 Codex 当前的登录
                  </div>
                  <div className="text-[13px] text-[#646970] dark:text-[#8D9398]">
                    检测到 li***@gmail.com（ChatGPT Pro），可保存为账号 ·
                    令牌只保存在本机，界面不显示
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    toast.success(
                      "已将当前 ChatGPT Pro 登录保存为官方主力账号",
                    );
                    setIsFirstLaunch(false);
                  }}
                  className="h-[32px] px-4 bg-[#12161C] dark:bg-[#EEF0F3] text-[#FDFDFE] dark:text-[#12161C] font-bold text-[13px] rounded-[4px] border-none cursor-pointer hover:bg-[#2A2F37]"
                >
                  保存为账号
                </button>
              </div>
            ) : (
              /* 选项 1B: 安装 Codex CLI */
              <div className="flex flex-row items-center justify-between p-[16px_20px] bg-[#F2F4F6] dark:bg-[#23282D] rounded-[6px] border border-[#DDE0E3] dark:border-[#31363D]">
                <div className="flex flex-col gap-[2px]">
                  <div className="text-[15px] font-bold text-[#12161C] dark:text-[#EEF0F3]">
                    安装 Codex CLI
                  </div>
                  <div className="text-[13px] text-[#646970] dark:text-[#8D9398]">
                    用 npm 全局安装 0.62.0，装到 %APPDATA%\npm\ ·
                    也可以在「Codex 管理」里改用独立安装包
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    toast.info("正在启动安装 Codex CLI…");
                    setIsCodexCliInstalled(true);
                  }}
                  className="h-[32px] px-4 bg-[#006AA0] text-[#FDFDFE] font-bold text-[13px] rounded-[4px] border-none cursor-pointer hover:bg-[#005a88]"
                >
                  安装
                </button>
              </div>
            )}

            {/* 选项 2: 添加第三方线路 */}
            <div className="flex flex-row items-center justify-between p-[16px_20px] bg-[#F2F4F6] dark:bg-[#23282D] rounded-[6px] border border-[#DDE0E3] dark:border-[#31363D]">
              <div className="flex flex-col gap-[2px]">
                <div className="text-[15px] font-bold text-[#12161C] dark:text-[#EEF0F3]">
                  添加第三方线路
                </div>
                <div className="text-[13px] text-[#646970] dark:text-[#8D9398]">
                  填写地址与 API 密钥，例如 DeepSeek、Kimi、智谱 GLM、OpenRouter
                  或自建网关。
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  onAdd();
                  setIsFirstLaunch(false);
                }}
                className="h-[32px] px-4 bg-[#12161C] dark:bg-[#EEF0F3] text-[#FDFDFE] dark:text-[#12161C] font-bold text-[13px] rounded-[4px] border-none cursor-pointer hover:bg-[#2A2F37]"
              >
                添加线路
              </button>
            </div>

            {/* 选项 3: 从 cc-switch 导入 */}
            <div className="flex flex-row items-center justify-between p-[16px_20px] bg-[#F2F4F6] dark:bg-[#23282D] rounded-[6px] border border-[#DDE0E3] dark:border-[#31363D]">
              <div className="flex flex-col gap-[2px]">
                <div className="text-[15px] font-bold text-[#12161C] dark:text-[#EEF0F3]">
                  从 cc-switch 导入
                </div>
                <div className="text-[13px] text-[#646970] dark:text-[#8D9398]">
                  检测到 cc-switch 配置里有 12 个供应商，逐条确认后导入。
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  toast.info("已打开从 cc-switch 导入弹窗");
                  setIsFirstLaunch(false);
                }}
                className="h-[32px] px-4 bg-[#FDFDFE] dark:bg-[#252A31] outline outline-1 outline-[#81878D] -outline-offset-[0.5px] text-[#12161C] dark:text-[#EEF0F3] font-bold text-[13px] rounded-[4px] border-none cursor-pointer hover:bg-[#E7EAED]"
              >
                导入…
              </button>
            </div>
          </div>

          {/* 底部小字 */}
          <div className="text-[12px]/[18px] text-[#81878D] dark:text-[#8D9398] text-center pt-2">
            其他工具（Claude Code、OpenCode 等）默认隐藏，可在「设置 ›
            工具」里启用。所有改动都要你先确认，每次写入前都会备份。
          </div>
        </div>
      </div>
    );
  }

  /* ========================================================================= */
  /* 主视图：线路管理 (支持双栏自适应 Frame 15 & 15B)                          */
  /* ========================================================================= */
  return (
    <div
      data-pencil-name="内容"
      className="box-border w-full flex-1 flex flex-col gap-0 p-[8px_24px] justify-start items-start bg-[#FDFDFE] dark:bg-[#171C21] h-full overflow-y-auto text-[#12161C] dark:text-[#EEF0F3]"
    >
      {/* 1. 页头 (Titles + Actions) */}
      <div
        data-pencil-name="页头"
        className="box-border w-full h-fit shrink-0 flex flex-row gap-[12px] justify-start items-center pb-2"
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
              className="text-[28px]/[36px] box-border text-[#12161C] dark:text-[#EEF0F3] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold text-left whitespace-nowrap m-0"
            >
              线路
            </h1>
          </div>
          <div
            data-pencil-name="说明"
            className="text-[13px]/[18px] box-border text-[#646970] dark:text-[#8D9398] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal text-left whitespace-nowrap"
          >
            Codex 同一时间只走一条线路 · 共 {allLines.length} 条
          </div>
        </div>

        {/* 顶部操作区 */}
        <div
          data-pencil-name="操作"
          className="box-border w-fit shrink-0 h-fit flex flex-row gap-[8px] justify-start items-center"
        >
          {/* 测试辅助按钮 */}
          <button
            type="button"
            onClick={handleTriggerParseError}
            title="模拟 config.toml 解析错误 (Frame 13C)"
            className="box-border w-fit shrink-0 h-[28px] px-2 flex items-center rounded text-[12px] text-[#915C08] bg-[#FFF8F2] dark:bg-[#2A2318] border border-[#F5D8BA] cursor-pointer"
          >
            模拟错误 13C
          </button>

          <button
            type="button"
            onClick={() => setIsFirstLaunch(true)}
            title="进入首次启动引导 (Frame 12)"
            className="box-border w-fit shrink-0 h-[28px] px-2 flex items-center rounded text-[12px] text-[#484E55] dark:text-[#BABEC3] bg-[#F2F4F6] dark:bg-[#252A31] border border-[#DDE0E3] dark:border-[#31363D] cursor-pointer"
          >
            首次引导 12
          </button>

          <button
            type="button"
            onClick={() => setIsWideLayout(!isWideLayout)}
            title="切换宽窗口双栏布局 (Frame 15/15B)"
            className="box-border w-fit shrink-0 h-[28px] px-2 flex items-center rounded text-[12px] text-[#484E55] dark:text-[#BABEC3] bg-[#F2F4F6] dark:bg-[#252A31] border border-[#DDE0E3] dark:border-[#31363D] cursor-pointer"
          >
            {isWideLayout ? "收起双栏" : "展开双栏 (15)"}
          </button>

          {/* 全部测速 */}
          <button
            type="button"
            onClick={handleTestAll}
            disabled={speedTestingAll || !!parseError}
            data-pencil-name="次要"
            className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] px-3 justify-center items-center bg-[#FDFDFE] dark:bg-[#1E2328] [outline:1px_solid_#81878D] [outline-offset:-0.5px] rounded-[4px] cursor-pointer hover:bg-[#F2F4F6] dark:hover:bg-[#282E35] transition text-[14px]/[20px] text-[#12161C] dark:text-[#EEF0F3] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal border-0 disabled:opacity-50"
          >
            <RefreshCw
              size={15}
              className={speedTestingAll ? "animate-spin" : ""}
            />
            <span>{speedTestingAll ? "测速中…" : "全部测速"}</span>
          </button>

          {/* 添加线路 */}
          <button
            type="button"
            onClick={onAdd}
            disabled={!!parseError}
            data-pencil-name="主要"
            className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] px-3 justify-center items-center bg-[#006AA0] hover:bg-[#005a88] active:bg-[#004a70] rounded-[4px] cursor-pointer transition text-[14px]/[20px] text-[#FDFDFE] font-['Noto_Sans_SC',system-ui,sans-serif] font-medium border-0 disabled:opacity-50"
          >
            <Plus size={16} />
            <span>添加线路</span>
          </button>
        </div>
      </div>

      {/* Frame 30: 13C 错误阻断横幅 (config.toml 无法解析) */}
      {parseError && (
        <div
          data-pencil-name="错误块"
          className="box-border w-full flex flex-col gap-[12px] p-[16px] my-2 bg-[#FFF8F2] dark:bg-[#2A2318] border border-[#F5A623] rounded-[6px]"
        >
          <div className="flex items-start gap-[10px]">
            <AlertTriangle
              size={20}
              className="text-[#C2410C] shrink-0 mt-[2px]"
            />
            <div className="flex flex-col gap-[2px]">
              <div className="text-[15px]/[22px] font-bold text-[#12161C] dark:text-[#EEF0F3]">
                {parseError.message}
              </div>
              <div className="text-[13px]/[18px] text-[#484E55] dark:text-[#BABEC3]">
                {parseError.reason}
              </div>
            </div>
          </div>

          {/* 代码预览 */}
          <div className="box-border w-full p-[10px_14px] bg-[#1A1E24] text-[#F5F7F9] rounded-[4px] font-['Overpass_Mono',monospace] text-[13px]/[20px]">
            {parseError.snippet.map((s) => (
              <div
                key={s.line}
                className={`flex flex-row gap-[16px] ${s.line === parseError.line ? "text-[#FF8B8B] font-bold" : "text-[#94999E]"}`}
              >
                <span className="w-[24px] select-none text-right opacity-60">
                  {s.line}
                </span>
                <span>{s.text}</span>
              </div>
            ))}
          </div>

          {/* 操作按钮 */}
          <div className="flex flex-row gap-[10px] items-center">
            <button
              type="button"
              onClick={() => toast.info("已在编辑器中打开 config.toml")}
              className="h-[30px] px-3 rounded bg-[#FDFDFE] dark:bg-[#252A31] border border-[#81878D] text-[13px] text-[#12161C] dark:text-[#EEF0F3] font-bold cursor-pointer hover:bg-[#F2F4F6]"
            >
              打开 config.toml
            </button>
            <button
              type="button"
              onClick={() => {
                toast.success(
                  `已从备份 ${parseError.backupId} 恢复 config.toml`,
                );
                setParseError(null);
              }}
              className="h-[30px] px-3 rounded bg-[#12161C] dark:bg-[#EEF0F3] text-[#FDFDFE] dark:text-[#12161C] text-[13px] font-bold cursor-pointer hover:bg-[#2A2F37] border-none"
            >
              从备份 {parseError.backupId} 恢复（{parseError.backupTime}）
            </button>
            <button
              type="button"
              onClick={() => {
                toast.info("正在重新读取 config.toml…");
                setParseError(null);
              }}
              className="h-[30px] px-3 rounded bg-[#FDFDFE] dark:bg-[#252A31] border border-[#81878D] text-[13px] text-[#12161C] dark:text-[#EEF0F3] font-bold cursor-pointer hover:bg-[#F2F4F6]"
            >
              重新读取
            </button>
          </div>
        </div>
      )}

      {/* Frame 53: 01E 线路删除撤销回执条 (刚刚 已删除「自建中转」，已备份 #0414) */}
      {deleteUndo && (
        <div
          data-pencil-name="撤销回执条 · 删除"
          className="box-border w-full h-[36px] shrink-0 flex flex-row gap-[12px] px-3 my-1 justify-start items-center bg-[#F2F4F6] dark:bg-[#23282D] rounded-[4px] border border-[#DDE0E3] dark:border-[#31363D]"
        >
          <div className="flex-1 text-[13px]/[18px] text-[#12161C] dark:text-[#EEF0F3]">
            <span className="font-bold text-[#BE2323]">
              {deleteUndo.timestamp}
            </span>{" "}
            已删除「{deleteUndo.name}」，已备份{" "}
            <span className="font-['Overpass_Mono',system-ui,sans-serif] font-bold">
              {deleteUndo.backupId}
            </span>
          </div>
          <button
            type="button"
            onClick={handleUndoDelete}
            className="h-[24px] px-2 flex items-center gap-1 rounded bg-[#12161C] dark:bg-[#EEF0F3] text-[#FDFDFE] dark:text-[#12161C] text-[12px] font-bold cursor-pointer hover:bg-[#2A2F37] border-none"
          >
            <Undo size={13} />
            <span>撤销</span>
          </button>
        </div>
      )}

      {/* 2. 站牌组 (StationSignboard + UndoReceipt) */}
      <div
        data-pencil-name="站牌组"
        className="box-border w-full h-fit shrink-0 flex flex-col gap-[8px] pt-1"
      >
        <StationSignboard
          currentProvider={activeProvider}
          latencyMs={latencies[activeLine.id] ?? activeLine.latencyMs}
          testingLatency={connection.kind === "checking"}
          onTestSpeed={() => {
            const currentLatency = latencies[activeLine.id] ?? 182;
            toast.info(`正在测试「${activeLine.name}」延迟…`);
            setTimeout(() => {
              setLatencies((prev) => ({
                ...prev,
                [activeLine.id]: Math.max(
                  80,
                  currentLatency - Math.floor(Math.random() * 20),
                ),
              }));
              toast.success(`测速成功：${activeLine.name} 响应正常`);
            }, 400);
          }}
          onEdit={() => onEdit(activeProvider)}
          undoReceipt={undoReceipt}
          onDefaultUndo={handleDefaultUndo}
        />
      </div>

      {/* 3. 两栏布局：左侧线路列表 + 右侧详情检查面板 (Frame 15 / 15B) */}
      <div
        data-pencil-name="两栏"
        className="box-border w-full flex-1 flex flex-row gap-[24px] justify-start items-start pt-3 overflow-hidden"
      >
        {/* 左栏：线路列表 */}
        <div className="flex-1 h-full flex flex-col gap-0 overflow-y-auto">
          {/* 筛选输入框 */}
          <div className="box-border w-full h-[32px] shrink-0 mb-2 flex flex-row gap-[8px] p-[0px_6px_0px_10px] items-center bg-[#FDFDFE] dark:bg-[#1A1E24] [outline:1px_solid_#81878D] [outline-offset:-0.5px] rounded-[4px]">
            <input
              ref={filterInputRef}
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="搜索线路、地址或模型 (Ctrl+F)"
              className="text-[13px]/[18px] flex-1 bg-transparent border-none outline-none text-[#12161C] dark:text-[#EEF0F3] placeholder-[#81878D]"
            />
            {filterText && (
              <button
                type="button"
                onClick={() => setFilterText("")}
                className="text-[12px] text-[#81878D] hover:text-[#12161C] bg-transparent border-none cursor-pointer"
              >
                清除
              </button>
            )}
          </div>

          {/* 表头 */}
          <div
            data-pencil-name="表头"
            className="box-border w-full h-[28px] shrink-0 flex flex-row gap-[12px] px-3 pl-2 justify-start items-center border-b border-[#DDE0E3] dark:border-[#23282D] text-[12px]/[17px] text-[#646970] dark:text-[#8D9398] font-['Noto_Sans_SC',system-ui,sans-serif]"
          >
            <div className="w-[3px] shrink-0" />
            <div className="w-[24px] shrink-0" />
            <div className="flex-1 text-left">线路</div>
            <div className="w-[96px] shrink-0 text-left">认证</div>
            <div className="w-[108px] shrink-0 text-left">协议</div>
            <div className="w-[138px] shrink-0 text-left">模型</div>
            <div className="w-[90px] shrink-0 text-right pr-2">延迟</div>
            <div className="w-[136px] shrink-0" />
          </div>

          {/* 分组 1: 官方账号 */}
          {filteredOfficialLines.length > 0 && (
            <div className="w-full flex flex-col gap-0">
              <div
                data-pencil-name="分组 · 官方账号"
                className="box-border w-full h-[32px] shrink-0 flex flex-row gap-[8px] px-3 pl-3 items-center"
              >
                <span className="text-[13px]/[18px] text-[#484E55] dark:text-[#B4B8BC] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold">
                  官方账号
                </span>
                <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398] font-[Overpass,system-ui,sans-serif]">
                  {officialLines.length}
                </span>
                <div className="flex-1" />
                {onNavigateToOfficialAccounts && (
                  <button
                    type="button"
                    onClick={onNavigateToOfficialAccounts}
                    className="box-border w-fit shrink-0 h-[28px] flex flex-row gap-[4px] px-2 items-center rounded text-[13px]/[18px] text-[#12161C] dark:text-[#EEF0F3] font-['Noto_Sans_SC',system-ui,sans-serif] hover:underline bg-transparent border-0 cursor-pointer"
                  >
                    <span>管理账号</span>
                    <ExternalLink size={13} className="text-[#646970]" />
                  </button>
                )}
              </div>

              {/* 官方行列表 */}
              {filteredOfficialLines.map((line) => {
                const active = line.id === activeCanonicalId;
                const isFocused = line.id === focusedLineId;
                const latency = latencies[line.id] ?? line.latencyMs;

                return (
                  <div
                    key={line.id}
                    onClick={() => setFocusedLineId(line.id)}
                    data-pencil-name={`线路 · ${line.name}`}
                    className={`box-border w-full h-[42px] shrink-0 flex flex-row gap-[12px] px-3 pl-2 justify-start items-center rounded-[4px] transition-colors cursor-pointer ${
                      isFocused
                        ? "bg-[#EAEFF5] dark:bg-[#202832] outline outline-1 outline-[#006AA0] -outline-offset-1"
                        : active
                          ? "bg-[#F2F4F6] dark:bg-[#23282D]"
                          : "hover:bg-[#F8F9FA] dark:hover:bg-[#1A1E24]"
                    }`}
                  >
                    {/* 左侧标记 */}
                    <div
                      className={`box-border w-[3px] shrink-0 h-[20px] rounded-[2px] ${
                        active ? "bg-[#537197]" : "opacity-0"
                      }`}
                    />
                    {/* 徽标 */}
                    <div className="box-border w-[24px] shrink-0 h-[24px] flex flex-row justify-center items-center bg-[#1A1E24] rounded-full">
                      <span className="text-[12px]/[17px] text-[#FDFDFE] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold">
                        {line.mark}
                      </span>
                    </div>
                    {/* 名称区 */}
                    <div className="box-border flex-1 h-fit flex flex-col justify-start items-start overflow-hidden">
                      <div className="text-[15px]/[21px] text-[#12161C] dark:text-[#EEF0F3] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal truncate">
                        {line.name}
                      </div>
                      <div className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398] font-['Overpass_Mono',system-ui,sans-serif] truncate">
                        {line.sub}
                      </div>
                    </div>
                    {/* 认证 */}
                    <div className="box-border w-[96px] shrink-0 text-[13px]/[18px] text-[#484E55] dark:text-[#BABEC3] font-['Noto_Sans_SC',system-ui,sans-serif] truncate">
                      {line.auth}
                    </div>
                    {/* 协议 */}
                    <div className="box-border w-[108px] shrink-0 text-[13px]/[18px] text-[#484E55] dark:text-[#BABEC3] font-['Noto_Sans_SC',system-ui,sans-serif] truncate">
                      {line.protocol}
                    </div>
                    {/* 模型 */}
                    <div className="box-border w-[138px] shrink-0 text-[13px]/[18px] font-['Overpass_Mono',system-ui,sans-serif] text-[#484E55] dark:text-[#BABEC3] truncate">
                      {line.model}
                    </div>
                    {/* 延迟 */}
                    <div className="box-border w-[90px] shrink-0 flex flex-row gap-[4px] justify-end items-center pr-2">
                      <span className="font-[Overpass,system-ui,sans-serif] text-[#12161C] dark:text-[#EEF0F3]">
                        {latency} ms
                      </span>
                      <span className="font-['Noto_Sans_SC',system-ui,sans-serif] font-bold text-[#05773B]">
                        {line.latencyGrade}
                      </span>
                    </div>
                    {/* 操作 */}
                    <div className="box-border w-[136px] shrink-0 flex flex-row gap-[4px] justify-end items-center">
                      {active ? (
                        <div className="box-border w-fit shrink-0 h-[20px] flex items-center px-2 bg-[#12161C] dark:bg-[#EEF0F3] rounded-full select-none">
                          <span className="text-[12px]/[17px] text-[#FDFDFE] dark:text-[#12161C] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold">
                            当前
                          </span>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSwitchLine(line);
                          }}
                          disabled={switchingId === line.id || !!parseError}
                          className="box-border w-fit shrink-0 h-[28px] px-2 flex items-center rounded text-[13px]/[18px] text-[#12161C] dark:text-[#EEF0F3] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold hover:bg-[#E7EAED] dark:hover:bg-[#31363D] bg-transparent border-0 cursor-pointer transition"
                        >
                          {switchingId === line.id ? "切换中…" : "切换"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* 分组 2: 第三方线路 */}
          {filteredThirdPartyLines.length > 0 && (
            <div className="w-full flex flex-col gap-0 pt-3">
              <div
                data-pencil-name="分组 · 第三方线路"
                className="box-border w-full h-[32px] shrink-0 flex flex-row gap-[8px] px-3 pl-3 items-center"
              >
                <span className="text-[13px]/[18px] text-[#484E55] dark:text-[#B4B8BC] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold">
                  第三方线路
                </span>
                <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398] font-[Overpass,system-ui,sans-serif]">
                  {thirdPartyLines.length}
                </span>
              </div>

              {/* 第三方行列表 */}
              {filteredThirdPartyLines.map((line) => {
                const active = line.id === activeCanonicalId;
                const isFocused = line.id === focusedLineId;
                const latency = latencies[line.id] ?? line.latencyMs;

                return (
                  <div
                    key={line.id}
                    onClick={() => setFocusedLineId(line.id)}
                    data-pencil-name={`线路 · ${line.name}`}
                    className={`box-border w-full h-[42px] shrink-0 flex flex-row gap-[12px] px-3 pl-2 justify-start items-center rounded-[4px] transition-colors cursor-pointer ${
                      isFocused
                        ? "bg-[#EAEFF5] dark:bg-[#202832] outline outline-1 outline-[#006AA0] -outline-offset-1"
                        : active
                          ? "bg-[#F2F4F6] dark:bg-[#23282D]"
                          : "hover:bg-[#F8F9FA] dark:hover:bg-[#1A1E24]"
                    }`}
                  >
                    {/* 左侧标记 */}
                    <div
                      className={`box-border w-[3px] shrink-0 h-[20px] rounded-[2px] ${
                        active ? "bg-[#537197]" : "opacity-0"
                      }`}
                    />
                    {/* 徽标 */}
                    <div
                      className="box-border w-[24px] shrink-0 h-[24px] flex flex-row justify-center items-center rounded-full"
                      style={{ backgroundColor: line.badgeColor }}
                    >
                      <span className="text-[12px]/[17px] text-[#FDFDFE] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold">
                        {line.mark}
                      </span>
                    </div>
                    {/* 名称区 */}
                    <div className="box-border flex-1 h-fit flex flex-col justify-start items-start overflow-hidden">
                      <div className="text-[15px]/[21px] text-[#12161C] dark:text-[#EEF0F3] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal truncate">
                        {line.name}
                      </div>
                      <div
                        className={`text-[13px]/[18px] truncate ${
                          line.timeout
                            ? "text-[#BE2323] font-['Noto_Sans_SC',system-ui,sans-serif]"
                            : "text-[#646970] dark:text-[#8D9398] font-['Overpass_Mono',system-ui,sans-serif]"
                        }`}
                      >
                        {line.sub}
                      </div>
                    </div>
                    {/* 认证 */}
                    <div className="box-border w-[96px] shrink-0 text-[13px]/[18px] text-[#484E55] dark:text-[#BABEC3] font-['Noto_Sans_SC',system-ui,sans-serif] truncate">
                      {line.auth}
                    </div>
                    {/* 协议 */}
                    <div className="box-border w-[108px] shrink-0 text-[13px]/[18px] text-[#484E55] dark:text-[#BABEC3] font-['Noto_Sans_SC',system-ui,sans-serif] truncate">
                      {line.protocol}
                    </div>
                    {/* 模型 */}
                    <div className="box-border w-[138px] shrink-0 text-[13px]/[18px] font-['Overpass_Mono',system-ui,sans-serif] text-[#484E55] dark:text-[#BABEC3] truncate">
                      {line.model}
                    </div>
                    {/* 延迟 */}
                    <div className="box-border w-[90px] shrink-0 flex flex-row gap-[4px] justify-end items-center pr-2">
                      {line.timeout ? (
                        <div className="flex items-center gap-1.5 text-[13px]/[18px]">
                          <span className="font-['Noto_Sans_SC',system-ui,sans-serif] font-bold text-[#BE2323]">
                            超时
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRetestLine(line.id);
                            }}
                            title="重测"
                            className="box-border w-[24px] h-[24px] flex items-center justify-center rounded text-[#484E55] hover:bg-[#E7EAED] dark:hover:bg-[#31363D] bg-transparent border-0 cursor-pointer"
                          >
                            <RefreshCw size={13} />
                          </button>
                        </div>
                      ) : latency ? (
                        <div className="flex items-center gap-1.5 text-[13px]/[18px]">
                          <span className="font-[Overpass,system-ui,sans-serif] text-[#12161C] dark:text-[#EEF0F3]">
                            {latency} ms
                          </span>
                          <span
                            className={`font-['Noto_Sans_SC',system-ui,sans-serif] font-bold ${
                              line.isSlow
                                ? "text-[#915C08]"
                                : latency < 300
                                  ? "text-[#05773B]"
                                  : "text-[#646970]"
                            }`}
                          >
                            {line.latencyGrade}
                          </span>
                        </div>
                      ) : (
                        <span className="text-[13px]/[18px] text-[#8D9398]">
                          —
                        </span>
                      )}
                    </div>
                    {/* 操作 */}
                    <div className="box-border w-[136px] shrink-0 flex flex-row gap-[4px] justify-end items-center">
                      {active ? (
                        <div className="box-border w-fit shrink-0 h-[20px] flex items-center px-2 bg-[#12161C] dark:bg-[#EEF0F3] rounded-full select-none">
                          <span className="text-[12px]/[17px] text-[#FDFDFE] dark:text-[#12161C] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold">
                            当前
                          </span>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSwitchLine(line);
                          }}
                          disabled={switchingId === line.id || !!parseError}
                          className="box-border w-fit shrink-0 h-[28px] px-2 flex items-center rounded text-[13px]/[18px] text-[#12161C] dark:text-[#EEF0F3] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold hover:bg-[#E7EAED] dark:hover:bg-[#31363D] bg-transparent border-0 cursor-pointer transition"
                        >
                          {switchingId === line.id ? "切换中…" : "切换"}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onEdit(activeProvider);
                        }}
                        title="编辑"
                        className="box-border w-[28px] shrink-0 h-[28px] flex items-center justify-center rounded text-[#484E55] dark:text-[#BABEC3] hover:bg-[#E7EAED] dark:hover:bg-[#31363D] bg-transparent border-0 cursor-pointer transition"
                      >
                        <Compass size={15} />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteLine(line);
                        }}
                        title="删除线路"
                        className="box-border w-[28px] shrink-0 h-[28px] flex items-center justify-center rounded text-[#484E55] hover:text-[#BE2323] hover:bg-[#E7EAED] dark:hover:bg-[#31363D] bg-transparent border-0 cursor-pointer transition"
                      >
                        <Undo size={14} className="rotate-180" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 右栏：宽窗口详情面板 (Frame 15 & Frame 15B 1:1) */}
        {isWideLayout && (
          <div
            data-pencil-name="右栏 · 详情面板"
            className="w-[420px] shrink-0 h-full flex flex-col gap-[16px] p-[16px_20px] bg-[#F8F9FA] dark:bg-[#1A1E24]/60 border border-[#E7EAED] dark:border-[#2D333B] rounded-[8px] overflow-y-auto"
          >
            {focusedLine ? (
              /* ================= Frame 15: 线路详情 (如 Kimi) ================= */
              <div className="flex flex-col gap-[16px]">
                {/* 聚焦提示 */}
                <div className="text-[12px] text-[#81878D] flex items-center gap-1">
                  <span>跟随列表里的键盘焦点</span>
                  <span className="font-bold">({focusedLine.name})</span>
                </div>

                {/* 线路卡头 */}
                <div className="flex flex-row items-center justify-between">
                  <div className="flex items-center gap-[10px]">
                    <div
                      className="w-[36px] h-[36px] rounded-full flex items-center justify-center text-[#FDFDFE] font-bold text-[15px]"
                      style={{ backgroundColor: focusedLine.badgeColor }}
                    >
                      {focusedLine.mark}
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[18px]/[24px] font-bold text-[#12161C] dark:text-[#EEF0F3]">
                        {focusedLine.name}
                      </span>
                      <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398]">
                        {focusedLine.isOfficial
                          ? "官方账号 · ChatGPT 登录"
                          : "第三方 · API 密钥"}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-[8px]">
                    <button
                      type="button"
                      onClick={() => handleSwitchLine(focusedLine)}
                      className="h-[30px] px-3 bg-[#12161C] dark:bg-[#EEF0F3] text-[#FDFDFE] dark:text-[#12161C] font-bold text-[13px] rounded-[4px] border-none cursor-pointer hover:bg-[#2A2F37]"
                    >
                      切换到 {focusedLine.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => onEdit(activeProvider)}
                      className="h-[30px] px-2.5 bg-[#FDFDFE] dark:bg-[#252A31] border border-[#81878D] text-[13px] font-bold rounded-[4px] cursor-pointer hover:bg-[#F2F4F6]"
                    >
                      编辑
                    </button>
                  </div>
                </div>

                {/* 切换后的路径 (4 节点) */}
                <div className="flex flex-col gap-[8px] p-[12px] bg-[#FFFFFF] dark:bg-[#12161C] rounded-[6px] border border-[#DDE0E3] dark:border-[#31363D]">
                  <span className="text-[12px] font-bold text-[#646970] dark:text-[#8D9398]">
                    切换后的路径
                  </span>
                  <div className="grid grid-cols-2 gap-[8px] text-[12px]/[16px]">
                    <div className="flex flex-col p-2 bg-[#F2F4F6] dark:bg-[#1A1E24] rounded">
                      <span className="text-[#81878D]">Codex</span>
                      <span className="font-bold text-[#12161C] dark:text-[#EEF0F3]">
                        CLI 0.61.0
                      </span>
                    </div>
                    <div className="flex flex-col p-2 bg-[#F2F4F6] dark:bg-[#1A1E24] rounded">
                      <span className="text-[#81878D]">本地代理</span>
                      <span className="font-bold text-[#12161C] dark:text-[#EEF0F3]">
                        Responses → Chat
                      </span>
                    </div>
                    <div className="flex flex-col p-2 bg-[#F2F4F6] dark:bg-[#1A1E24] rounded">
                      <span className="text-[#81878D]">端点</span>
                      <span className="font-bold text-[#05773B]">
                        HTTP 200 · 310 ms
                      </span>
                    </div>
                    <div className="flex flex-col p-2 bg-[#F2F4F6] dark:bg-[#1A1E24] rounded">
                      <span className="text-[#81878D]">默认模型</span>
                      <span className="font-bold text-[#12161C] dark:text-[#EEF0F3] truncate">
                        {focusedLine.model}
                      </span>
                    </div>
                  </div>
                </div>

                {/* 最近 8 次测速图表 */}
                <div className="flex flex-col gap-[8px] p-[12px] bg-[#FFFFFF] dark:bg-[#12161C] rounded-[6px] border border-[#DDE0E3] dark:border-[#31363D]">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-bold text-[#646970] dark:text-[#8D9398]">
                      最近 8 次测速
                    </span>
                    <span className="text-[12px] font-bold text-[#12161C] dark:text-[#EEF0F3]">
                      中位数 310 ms
                    </span>
                  </div>
                  <div className="text-[12px] text-[#915C08]">
                    9 月 26 日 20:14 有一次 1200 ms（慢）· 其余 7 次在 280 至
                    330 ms
                  </div>
                  {/* 测速柱条 */}
                  <div className="flex items-end gap-[8px] h-[64px] pt-2">
                    {[290, 310, 280, 1200, 305, 315, 295, 310].map((v, i) => (
                      <div
                        key={i}
                        className="flex-1 flex flex-col items-center gap-1 h-full justify-end"
                      >
                        <div
                          className={`w-full rounded-[2px] ${v > 500 ? "bg-[#C2410C]" : "bg-[#537197]"}`}
                          style={{
                            height: `${Math.min(54, Math.max(12, (v / 1200) * 54))}px`,
                          }}
                          title={`${v} ms`}
                        />
                      </div>
                    ))}
                  </div>
                </div>

                {/* 凭据与改写说明 */}
                <div className="flex flex-col gap-[6px] text-[12px]/[18px] text-[#646970] dark:text-[#8D9398]">
                  <div className="flex items-center gap-[6px]">
                    <ShieldCheck size={14} className="text-[#05773B]" />
                    <span>密钥在系统凭据库 · 末 4 位 9d2e</span>
                  </div>
                  <div className="flex items-center gap-[6px]">
                    <Check size={14} className="text-[#05773B]" />
                    <span>切换时改写 config.toml：model_provider 与 model</span>
                  </div>
                  <div className="flex items-center gap-[6px]">
                    <Clock size={14} className="text-[#484E55]" />
                    <span>写入前备份，可在回执里撤销</span>
                  </div>
                </div>
              </div>
            ) : (
              /* ================= Frame 15B: 列表无焦点 (线路概况) ================= */
              <div className="flex flex-col gap-[16px]">
                <div className="flex flex-col gap-[2px]">
                  <h3 className="text-[16px]/[22px] font-bold text-[#12161C] dark:text-[#EEF0F3] m-0">
                    线路概况
                  </h3>
                  <span className="text-[12px] text-[#81878D]">
                    按 ↑ ↓ 或点一行，查看那条线路的详情
                  </span>
                </div>

                {/* 9 条线路指标卡 */}
                <div className="grid grid-cols-2 gap-[8px] text-[12px]/[16px]">
                  <div className="flex flex-col p-2.5 bg-[#FFFFFF] dark:bg-[#12161C] rounded border border-[#DDE0E3] dark:border-[#31363D]">
                    <span className="text-[#81878D]">正常 6</span>
                    <span className="font-bold text-[#05773B]">
                      快 4 · 中 2
                    </span>
                  </div>
                  <div className="flex flex-col p-2.5 bg-[#FFFFFF] dark:bg-[#12161C] rounded border border-[#DDE0E3] dark:border-[#31363D]">
                    <span className="text-[#81878D]">慢 1</span>
                    <span className="font-bold text-[#915C08]">
                      智谱 GLM · 1200 ms
                    </span>
                  </div>
                  <div className="flex flex-col p-2.5 bg-[#FFFFFF] dark:bg-[#12161C] rounded border border-[#DDE0E3] dark:border-[#31363D]">
                    <span className="text-[#81878D]">超时 1</span>
                    <span className="font-bold text-[#BE2323]">
                      自建中转 10 s 无响应
                    </span>
                  </div>
                  <div className="flex flex-col p-2.5 bg-[#FFFFFF] dark:bg-[#12161C] rounded border border-[#DDE0E3] dark:border-[#31363D]">
                    <span className="text-[#81878D]">需重新登录 1</span>
                    <span className="font-bold text-[#C2410C]">
                      OpenAI 官方 · 备用
                    </span>
                  </div>
                </div>

                {/* 需要处理卡片 */}
                <div className="flex flex-col gap-[8px] p-[12px] bg-[#FFFFFF] dark:bg-[#12161C] rounded-[6px] border border-[#DDE0E3] dark:border-[#31363D]">
                  <span className="text-[13px] font-bold text-[#12161C] dark:text-[#EEF0F3]">
                    需要处理
                  </span>
                  <div className="flex flex-col gap-[6px]">
                    <div className="flex items-center justify-between p-1.5 hover:bg-[#F2F4F6] rounded text-[13px]">
                      <span className="font-bold text-[#BE2323]">自建中转</span>
                      <button
                        type="button"
                        onClick={() => handleRetestLine("custom")}
                        className="h-[24px] px-2 text-[12px] bg-[#FDFDFE] border border-[#81878D] rounded cursor-pointer"
                      >
                        重新测速
                      </button>
                    </div>
                    <div className="flex items-center justify-between p-1.5 hover:bg-[#F2F4F6] rounded text-[13px]">
                      <span className="font-bold text-[#915C08]">智谱 GLM</span>
                      <button
                        type="button"
                        onClick={() => toast.info("正在重测智谱 GLM…")}
                        className="h-[24px] px-2 text-[12px] bg-[#FDFDFE] border border-[#81878D] rounded cursor-pointer"
                      >
                        重新测速
                      </button>
                    </div>
                    <div className="flex items-center justify-between p-1.5 hover:bg-[#F2F4F6] rounded text-[13px]">
                      <span className="font-bold text-[#C2410C]">
                        OpenAI 官方 · 备用
                      </span>
                      <button
                        type="button"
                        onClick={() => onNavigateToOfficialAccounts?.()}
                        className="h-[24px] px-2 text-[12px] bg-[#12161C] text-white rounded border-none cursor-pointer"
                      >
                        重新登录
                      </button>
                    </div>
                  </div>
                </div>

                {/* 最近切换历史 */}
                <div className="flex flex-col gap-[8px] p-[12px] bg-[#FFFFFF] dark:bg-[#12161C] rounded-[6px] border border-[#DDE0E3] dark:border-[#31363D]">
                  <span className="text-[13px] font-bold text-[#12161C] dark:text-[#EEF0F3]">
                    最近切换
                  </span>
                  <div className="flex flex-col gap-[6px] text-[12px]/[18px]">
                    <div className="flex items-center justify-between">
                      <span className="text-[#81878D]">14:20</span>
                      <span className="font-bold">主力 → DeepSeek</span>
                      <button
                        type="button"
                        onClick={handleDefaultUndo}
                        className="text-[12px] text-[#006AA0] underline bg-transparent border-none cursor-pointer"
                      >
                        撤销
                      </button>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[#81878D]">12:55</span>
                      <span className="font-bold">Kimi → 主力</span>
                      <span className="text-[#81878D]">已生效</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
