import { useState } from "react";
import { toast } from "sonner";
import {
  FolderOpen,
  MoreHorizontal,
  Download,
  ExternalLink,
  X,
  RotateCcw,
} from "lucide-react";
import {
  CANONICAL_BACKUPS,
  CANONICAL_SETTINGS_TOOLS,
  CANONICAL_CC_SWITCH_IMPORT_ITEMS,
  type CanonicalBackup,
  type CanonicalSettingsTool,
  type CanonicalCcSwitchItem,
} from "@/data/canonicalData";

interface SettingsViewProps {
  onBack?: () => void;
}

export function SettingsView({ onBack: _onBack }: SettingsViewProps) {
  const [activeTab, setActiveTab] = useState<
    "tools" | "import" | "backups" | "general" | "update"
  >("backups");

  const [language, setLanguage] = useState<"zh-CN" | "en-US">("zh-CN");
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [closeAction, setCloseAction] = useState<"tray" | "exit">("tray");
  const [backups] = useState<CanonicalBackup[]>(CANONICAL_BACKUPS);
  const [tools, setTools] = useState<CanonicalSettingsTool[]>(
    CANONICAL_SETTINGS_TOOLS,
  );

  // 11B 首次启用工具弹窗
  const [firstEnableModalTool, setFirstEnableModalTool] =
    useState<CanonicalSettingsTool | null>(null);

  // 11D 恢复备份确认弹窗
  const [restoreConfirmBackup, setRestoreConfirmBackup] =
    useState<CanonicalBackup | null>(null);

  // 13G 从 cc-switch 导入确认弹窗
  const [ccSwitchImportOpen, setCcSwitchImportOpen] = useState(false);
  const [ccSwitchItems, setCcSwitchItems] = useState<CanonicalCcSwitchItem[]>(
    CANONICAL_CC_SWITCH_IMPORT_ITEMS,
  );

  const handleOpenFolder = () => {
    toast.info("已在文件资源管理器中打开备份目录", {
      description: "Chimera\\backups\\",
    });
  };

  const handleToolToggle = (tool: CanonicalSettingsTool) => {
    if (tool.id === "codex") {
      toast.info("Codex 是 Chimera++ 核心干线，始终保持显示");
      return;
    }
    if (tool.status === "detected") {
      // 打开 11B 首次启用向导弹窗
      setFirstEnableModalTool(tool);
    } else if (tool.status === "enabled") {
      setTools((prev) =>
        prev.map((t) =>
          t.id === tool.id
            ? { ...t, status: "detected", statusLabel: "未启用（已检测到）" }
            : t,
        ),
      );
      toast.success(`已停用 ${tool.name}，侧栏已安全收起`);
    } else {
      toast.info(`请先安装 ${tool.name} 后再启用`);
    }
  };

  const handleConfirmFirstEnable = () => {
    if (!firstEnableModalTool) return;
    setTools((prev) =>
      prev.map((t) =>
        t.id === firstEnableModalTool.id
          ? { ...t, status: "enabled", statusLabel: "已启用" }
          : t,
      ),
    );
    toast.success(
      `已成功启用 ${firstEnableModalTool.name}！已自动备份现有配置文件并登记条目`,
    );
    setFirstEnableModalTool(null);
  };

  const handleConfirmRestore = () => {
    if (!restoreConfirmBackup) return;
    toast.success(`已安全恢复备份 ${restoreConfirmBackup.number}！`, {
      description: `原状态已自动生成快照保存，重启 Codex 后生效。`,
    });
    setRestoreConfirmBackup(null);
  };

  const handleToggleCcSwitchItem = (id: string) => {
    setCcSwitchItems((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, checked: !item.checked } : item,
      ),
    );
  };

  const handleConfirmCcSwitchImport = () => {
    const selectedCount = ccSwitchItems.filter(
      (i) => i.category === "new" && i.checked,
    ).length;
    toast.success(
      `已从 cc-switch 成功导入 ${selectedCount} 条新线路！已安全备份原配置`,
    );
    setCcSwitchImportOpen(false);
  };

  return (
    <div
      data-pencil-name="11 设置"
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
              设置
            </h1>
          </div>
          <div
            data-pencil-name="说明"
            className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398] text-left"
          >
            Chimera++ 2.8.0 · 配置只保存在本机
          </div>
        </div>
        <div
          data-pencil-name="操作"
          className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[8px] justify-start items-center"
        />
      </div>

      {/* 摘要行 · 备份 (Frame 11) */}
      <div
        data-pencil-name="摘要行 · 备份"
        className="box-border w-full h-fit shrink-0 flex flex-row gap-[12px] py-[6px] px-[12px] rounded-[6px] bg-[#F2F4F6] dark:bg-[#1A1E24] justify-start items-center"
      >
        <div
          data-pencil-name="项 · 自动备份"
          className="box-border w-fit shrink-0 h-fit flex flex-row gap-[6px] justify-start items-center"
        >
          <span className="text-[13px]/[18px] text-[#484E55] dark:text-[#94999E]">
            自动备份
          </span>
          <span className="text-[13px]/[18px] text-[#12161C] dark:text-[#F5F7F9] font-bold">
            保留 30 份
          </span>
        </div>
        <div className="box-border w-[1px] shrink-0 h-[12px] bg-[#DDE0E3] dark:bg-[#31363D]" />
        <div
          data-pencil-name="项 · 最新"
          className="box-border w-fit shrink-0 h-fit flex flex-row gap-[6px] justify-start items-center"
        >
          <span className="text-[13px]/[18px] text-[#484E55] dark:text-[#94999E]">
            最新
          </span>
          <span className="text-[13px]/[18px] text-[#12161C] dark:text-[#F5F7F9] font-mono font-bold">
            #0412
          </span>
        </div>
        <div
          data-pencil-name="项 · 今天 14:20 · 切换到 DeepSeek 前"
          className="box-border w-fit shrink-0 h-fit flex flex-row gap-[6px] justify-start items-center"
        >
          <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398]">
            今天 14:20 · 切换到 DeepSeek 前
          </span>
        </div>
        <div className="box-border w-[1px] shrink-0 h-[12px] bg-[#DDE0E3] dark:bg-[#31363D]" />
        <div
          data-pencil-name="项 · 目录"
          className="box-border w-fit shrink-0 h-fit flex flex-row gap-[6px] justify-start items-center"
        >
          <span className="text-[13px]/[18px] text-[#484E55] dark:text-[#94999E]">
            目录
          </span>
          <span className="text-[13px]/[18px] text-[#12161C] dark:text-[#F5F7F9] font-mono font-bold">
            Chimera\backups\
          </span>
        </div>
      </div>

      {/* 主体左右分区 */}
      <div
        data-pencil-name="主体"
        className="box-border w-full flex-1 flex flex-row gap-[32px] justify-start items-start"
      >
        {/* 左侧二级目录 */}
        <div
          data-pencil-name="目录"
          className="box-border w-[160px] shrink-0 h-fit flex flex-col gap-[2px] justify-start items-start select-none"
        >
          {[
            { id: "tools", label: "工具" },
            { id: "import", label: "导入" },
            { id: "backups", label: "备份与恢复" },
            { id: "general", label: "语言与通用" },
            { id: "update", label: "应用更新" },
          ].map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id as any)}
                className={`box-border w-full h-[32px] shrink-0 flex flex-row gap-[10px] px-[10px] justify-start items-center rounded-[4px] border-0 cursor-pointer text-left transition-colors ${
                  active
                    ? "bg-[#F2F4F6] dark:bg-[#23282D]"
                    : "bg-transparent hover:bg-[#F2F4F6]/50 dark:hover:bg-[#1A1E24]"
                }`}
              >
                <div
                  className={`box-border w-[2px] shrink-0 h-[16px] rounded-[2px] transition-colors ${
                    active ? "bg-[#006AA0] dark:bg-[#388BFD]" : "bg-transparent"
                  }`}
                />
                <span
                  className={`text-[14px]/[20px] ${
                    active
                      ? "text-[#12161C] dark:text-[#EEF0F3] font-bold"
                      : "text-[#484E55] dark:text-[#BABEC3] font-normal"
                  }`}
                >
                  {item.label}
                </span>
              </button>
            );
          })}
        </div>

        {/* 右侧面板 */}
        <div
          data-pencil-name="内容"
          className="box-border flex-1 h-fit flex flex-col gap-[32px] justify-start items-start"
        >
          {/* 11C 设置 · 工具 模块 */}
          {activeTab === "tools" && (
            <div
              data-pencil-name="11C 设置 · 工具"
              className="box-border w-full h-fit shrink-0 flex flex-col gap-[16px] justify-start items-start"
            >
              <div className="box-border w-full h-fit flex flex-col gap-[2px]">
                <h2 className="text-[18px]/[23px] m-0 p-0 text-[#12161C] dark:text-[#EEF0F3] font-bold text-left">
                  工具
                </h2>
                <div className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398]">
                  已启用 5（含 Codex）/ 未启用 3 / 未检测到 2 ·
                  切换类有当前线路，累加类条目各自启停
                </div>
              </div>

              {/* 工具列表 */}
              <div className="box-border w-full h-fit flex flex-col gap-0 border-b border-[#DDE0E3] dark:border-[#31363D]">
                {tools.map((t) => {
                  const isEnabled = t.status === "enabled";
                  const isNotInstalled = t.status === "not_installed";

                  return (
                    <div
                      key={t.id}
                      className="box-border w-full min-h-[48px] py-[8px] px-[8px] flex flex-row gap-[12px] justify-start items-center border-b border-[#DDE0E3] dark:border-[#31363D] hover:bg-[#F2F4F6]/40 dark:hover:bg-[#1A1E24]/40 transition-colors"
                    >
                      {/* 工具标识徽标 */}
                      <div className="box-border w-[28px] h-[28px] shrink-0 flex items-center justify-center rounded-[4px] bg-[#12161C] text-[#FDFDFE] text-[12px] font-bold font-mono">
                        {t.shortName}
                      </div>

                      {/* 工具名与模式 */}
                      <div className="box-border w-[140px] shrink-0 flex flex-row items-center gap-[6px]">
                        <span className="text-[14px]/[20px] text-[#12161C] dark:text-[#EEF0F3] font-bold">
                          {t.name}
                        </span>
                        <span className="text-[12px]/[16px] px-[6px] py-[1px] rounded-[3px] bg-[#F2F4F6] dark:bg-[#23282D] text-[#646970] dark:text-[#8D9398]">
                          {t.categoryLabel}
                        </span>
                      </div>

                      {/* 状态与附加信息 */}
                      <div className="flex-1 flex flex-row items-center gap-[8px] text-[13px]/[18px] text-[#646970] dark:text-[#8D9398]">
                        <span>{t.statusLabel}</span>
                        {t.badgeSub && (
                          <span className="text-[#12161C] dark:text-[#EEF0F3]">
                            · {t.badgeSub}
                          </span>
                        )}
                        {t.countText && (
                          <span className="text-[#05773B] font-mono font-bold">
                            · 启用 {t.countText}
                          </span>
                        )}
                      </div>

                      {/* 操作控制 */}
                      <div className="box-border w-fit shrink-0 flex flex-row gap-[8px] items-center">
                        {isNotInstalled ? (
                          <button
                            type="button"
                            onClick={() =>
                              toast.info(`正在打开 ${t.name} 官方安装文档...`)
                            }
                            className="box-border h-[28px] px-[8px] flex flex-row gap-[4px] items-center rounded-[4px] border border-[#81878D] dark:border-[#484E55] bg-transparent text-[12px] text-[#12161C] dark:text-[#EEF0F3] cursor-pointer hover:bg-[#F2F4F6] dark:hover:bg-[#23282D]"
                          >
                            <span>安装说明</span>
                            <ExternalLink size={12} />
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleToolToggle(t)}
                            className={`box-border w-[36px] h-[20px] p-[2px] flex items-center rounded-full border-0 cursor-pointer transition-colors ${
                              isEnabled
                                ? "bg-[#12161C] dark:bg-[#388BFD] justify-end"
                                : "bg-[#DDE0E3] dark:bg-[#31363D] justify-start"
                            }`}
                          >
                            <div className="w-[16px] h-[16px] rounded-full bg-[#FDFDFE] shadow-sm" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* 底部：从 cc-switch 导入卡片 (Frame 11C 底部) */}
              <div className="box-border w-full p-[14px_16px] rounded-[6px] bg-[#F2F4F6] dark:bg-[#1A1E24] border border-[#DDE0E3] dark:border-[#31363D] flex flex-row gap-[12px] items-center">
                <Download
                  size={20}
                  className="text-[#484E55] dark:text-[#94999E] shrink-0"
                />
                <div className="flex-1 flex flex-col gap-[2px]">
                  <div className="text-[14px]/[20px] text-[#12161C] dark:text-[#EEF0F3] font-bold">
                    从 cc-switch 导入
                  </div>
                  <div className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398]">
                    读取 C:\Users\lin\.cc-switch\config.json，共 12
                    个供应商，逐条确认后导入
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setCcSwitchImportOpen(true)}
                  className="box-border h-[32px] px-[12px] flex items-center justify-center rounded-[4px] bg-[#FDFDFE] dark:bg-[#23282D] outline outline-1 outline-[#81878D] dark:outline-[#484E55] -outline-offset-1 text-[13px] text-[#12161C] dark:text-[#EEF0F3] font-medium border-0 cursor-pointer hover:bg-[#ECEFF2] dark:hover:bg-[#2C3238]"
                >
                  导入…
                </button>
              </div>
            </div>
          )}

          {/* 备份与恢复模块 (Frame 11 / 11D) */}
          {(activeTab === "backups" || activeTab === "general") && (
            <div
              data-pencil-name="备份与恢复"
              className="box-border w-full h-fit shrink-0 flex flex-col gap-[8px] justify-start items-start"
            >
              <div
                data-pencil-name="标题行"
                className="box-border w-full h-fit shrink-0 flex flex-row gap-[12px] justify-start items-center"
              >
                <div
                  data-pencil-name="文字"
                  className="box-border flex-1 h-fit flex flex-col gap-[2px] justify-start items-start"
                >
                  <h2 className="text-[18px]/[23px] m-0 p-0 text-[#12161C] dark:text-[#EEF0F3] font-bold text-left">
                    备份与恢复
                  </h2>
                </div>
                <button
                  type="button"
                  data-pencil-name="打开文件夹"
                  onClick={handleOpenFolder}
                  className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] px-[12px] justify-center items-center bg-[#FDFDFE] dark:bg-[#23282D] outline outline-1 outline-[#81878D] dark:outline-[#484E55] -outline-offset-1 rounded-[4px] cursor-pointer hover:bg-[#F2F4F6] dark:hover:bg-[#2C3238] transition-colors"
                >
                  <FolderOpen
                    size={16}
                    className="text-[#12161C] dark:text-[#EEF0F3]"
                  />
                  <span className="text-[14px]/[20px] text-[#12161C] dark:text-[#EEF0F3] font-normal">
                    打开文件夹
                  </span>
                </button>
              </div>

              {/* 备份列表 */}
              <div
                data-pencil-name="备份列表"
                className="box-border w-full h-fit shrink-0 flex flex-col gap-0 justify-start items-start border-b border-[#DDE0E3] dark:border-[#31363D]"
              >
                {/* 表头 */}
                <div
                  data-pencil-name="表头"
                  className="box-border w-full h-[28px] shrink-0 flex flex-row gap-[12px] px-[8px] justify-start items-center border-b border-[#DDE0E3] dark:border-[#31363D]"
                >
                  <div className="text-[12px]/[17px] w-[116px] shrink-0 text-[#646970] dark:text-[#8D9398] text-left">
                    时间
                  </div>
                  <div className="text-[12px]/[17px] w-[200px] shrink-0 text-[#646970] dark:text-[#8D9398] text-left">
                    触发
                  </div>
                  <div className="text-[12px]/[17px] w-[180px] shrink-0 text-[#646970] dark:text-[#8D9398] text-left">
                    包含文件
                  </div>
                  <div className="text-[12px]/[17px] w-[60px] shrink-0 text-[#646970] dark:text-[#8D9398] text-left">
                    大小
                  </div>
                  <div className="flex-1" />
                </div>

                {/* 列表行 */}
                {backups.map((b) => (
                  <div
                    key={b.id}
                    data-pencil-name={`备份 ${b.number}`}
                    className="box-border w-full h-[44px] shrink-0 flex flex-row gap-[12px] px-[8px] justify-start items-center border-b border-[#DDE0E3] dark:border-[#31363D] hover:bg-[#F2F4F6]/50 dark:hover:bg-[#1A1E24]/50 transition-colors"
                  >
                    <div className="w-[116px] shrink-0 flex flex-col justify-start items-start">
                      <span className="text-[13px]/[18px] text-[#12161C] dark:text-[#EEF0F3]">
                        {b.time}
                      </span>
                      <span className="text-[12px]/[16px] text-[#646970] dark:text-[#8D9398] font-mono">
                        {b.number}
                      </span>
                    </div>
                    <div className="w-[200px] shrink-0 text-[13px]/[18px] text-[#12161C] dark:text-[#EEF0F3] truncate">
                      {b.trigger}
                    </div>
                    <div className="w-[180px] shrink-0 text-[13px]/[18px] text-[#484E55] dark:text-[#BABEC3] font-mono truncate">
                      {b.files}
                    </div>
                    <div className="w-[60px] shrink-0 text-[13px]/[18px] text-[#646970] dark:text-[#8D9398] font-mono">
                      {b.size}
                    </div>
                    <div className="flex-1" />
                    <button
                      type="button"
                      onClick={() => setRestoreConfirmBackup(b)}
                      className="box-border w-fit shrink-0 h-[28px] px-[8px] flex items-center justify-center bg-transparent hover:bg-[#DDE0E3]/50 dark:hover:bg-[#31363D] rounded-[4px] border-0 cursor-pointer text-[13px]/[18px] text-[#12161C] dark:text-[#EEF0F3] font-bold"
                    >
                      恢复
                    </button>
                    <button
                      type="button"
                      aria-label="更多选项"
                      className="box-border w-[28px] h-[28px] flex items-center justify-center bg-transparent hover:bg-[#DDE0E3]/50 dark:hover:bg-[#31363D] rounded-[4px] border-0 cursor-pointer text-[#484E55] dark:text-[#8D9398]"
                    >
                      <MoreHorizontal size={16} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 语言与通用模块 */}
          {activeTab === "general" && (
            <div
              data-pencil-name="语言与通用"
              className="box-border w-full h-fit shrink-0 flex flex-col gap-0 justify-start items-start"
            >
              <h2 className="text-[18px]/[23px] m-0 mb-[8px] p-0 text-[#12161C] dark:text-[#EEF0F3] font-bold text-left">
                语言与通用
              </h2>

              {/* 界面语言 */}
              <div
                data-pencil-name="项 · 界面语言"
                className="box-border w-full h-[52px] shrink-0 flex flex-row gap-[16px] justify-start items-center border-b border-[#DDE0E3] dark:border-[#31363D]"
              >
                <div className="flex-1 flex flex-col gap-[2px]">
                  <span className="text-[14px]/[20px] text-[#12161C] dark:text-[#EEF0F3]">
                    界面语言
                  </span>
                </div>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as any)}
                  className="box-border w-[200px] h-[32px] px-[10px] bg-[#FDFDFE] dark:bg-[#1A1E24] text-[#12161C] dark:text-[#EEF0F3] text-[13px] outline outline-1 outline-[#81878D] dark:outline-[#484E55] -outline-offset-1 rounded-[4px] cursor-pointer"
                >
                  <option value="zh-CN">简体中文</option>
                  <option value="en-US">English</option>
                </select>
              </div>

              {/* 应用主题 */}
              <div
                data-pencil-name="项 · 应用主题"
                className="box-border w-full h-[52px] shrink-0 flex flex-row gap-[16px] justify-start items-center border-b border-[#DDE0E3] dark:border-[#31363D]"
              >
                <div className="flex-1 flex flex-col gap-[2px]">
                  <span className="text-[14px]/[20px] text-[#12161C] dark:text-[#EEF0F3]">
                    应用主题
                  </span>
                  <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398]">
                    只改变 Chimera++ 自身；Codex 皮肤在「外观」里
                  </span>
                </div>
                <div className="box-border w-fit h-[32px] flex flex-row gap-[2px] p-[2px] justify-start items-center bg-[#ECEFF2] dark:bg-[#23282D] rounded-[4px]">
                  {[
                    { id: "system", label: "跟随系统" },
                    { id: "light", label: "浅色" },
                    { id: "dark", label: "深色" },
                  ].map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setTheme(t.id as any)}
                      className={`box-border w-fit h-[28px] px-[12px] flex items-center justify-center rounded-[2px] border-0 cursor-pointer text-[14px]/[20px] transition-colors ${
                        theme === t.id
                          ? "bg-[#FDFDFE] dark:bg-[#171C21] text-[#12161C] dark:text-[#EEF0F3] font-bold shadow-sm outline outline-1 outline-[#81878D]/40"
                          : "bg-transparent text-[#484E55] dark:text-[#BABEC3] font-normal"
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 开机时启动 */}
              <div
                data-pencil-name="项 · 开机时启动"
                className="box-border w-full h-[52px] shrink-0 flex flex-row gap-[16px] justify-start items-center border-b border-[#DDE0E3] dark:border-[#31363D]"
              >
                <div className="flex-1 flex flex-col gap-[2px]">
                  <span className="text-[14px]/[20px] text-[#12161C] dark:text-[#EEF0F3]">
                    开机时启动
                  </span>
                  <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398]">
                    启动后只驻留托盘，不打开窗口
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setAutoLaunch(!autoLaunch)}
                  className={`box-border w-[36px] h-[20px] p-[4px] flex items-center rounded-full border-0 cursor-pointer transition-colors ${
                    autoLaunch
                      ? "bg-[#12161C] dark:bg-[#388BFD] justify-end"
                      : "bg-[#FDFDFE] dark:bg-[#23282D] outline outline-1 outline-[#81878D] justify-start"
                  }`}
                >
                  <div
                    className={`w-[12px] h-[12px] rounded-full transition-all ${
                      autoLaunch
                        ? "bg-[#FDFDFE]"
                        : "bg-[#646970] dark:bg-[#BABEC3]"
                    }`}
                  />
                </button>
              </div>

              {/* 关闭窗口时 */}
              <div
                data-pencil-name="项 · 关闭窗口时"
                className="box-border w-full h-[52px] shrink-0 flex flex-row gap-[16px] justify-start items-center border-b border-[#DDE0E3] dark:border-[#31363D]"
              >
                <div className="flex-1 flex flex-col gap-[2px]">
                  <span className="text-[14px]/[20px] text-[#12161C] dark:text-[#EEF0F3]">
                    关闭窗口时
                  </span>
                </div>
                <div className="flex flex-row gap-[16px] items-center">
                  <label
                    onClick={() => setCloseAction("tray")}
                    className="flex flex-row gap-[8px] items-center cursor-pointer text-[14px]/[20px] text-[#12161C] dark:text-[#EEF0F3]"
                  >
                    <span
                      className={`w-[16px] h-[16px] rounded-full flex items-center justify-center ${
                        closeAction === "tray"
                          ? "bg-[#12161C] dark:bg-[#388BFD]"
                          : "border border-[#81878D]"
                      }`}
                    >
                      {closeAction === "tray" && (
                        <span className="w-[6px] h-[6px] rounded-full bg-[#FDFDFE]" />
                      )}
                    </span>
                    最小化到托盘
                  </label>
                  <label
                    onClick={() => setCloseAction("exit")}
                    className="flex flex-row gap-[8px] items-center cursor-pointer text-[14px]/[20px] text-[#12161C] dark:text-[#EEF0F3]"
                  >
                    <span
                      className={`w-[16px] h-[16px] rounded-full flex items-center justify-center ${
                        closeAction === "exit"
                          ? "bg-[#12161C] dark:bg-[#388BFD]"
                          : "border border-[#81878D]"
                      }`}
                    >
                      {closeAction === "exit" && (
                        <span className="w-[6px] h-[6px] rounded-full bg-[#FDFDFE]" />
                      )}
                    </span>
                    退出 Chimera++
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* 应用更新模块 */}
          {activeTab === "update" && (
            <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[16px] justify-start items-start">
              <h2 className="text-[18px]/[23px] m-0 p-0 text-[#12161C] dark:text-[#EEF0F3] font-bold text-left">
                应用更新
              </h2>
              <div className="w-full p-[16px] rounded-[8px] bg-[#F2F4F6] dark:bg-[#1A1E24] border border-[#DDE0E3] dark:border-[#31363D] flex flex-col gap-[12px]">
                <div className="flex flex-row justify-between items-center">
                  <div>
                    <div className="text-[15px] font-bold text-[#12161C] dark:text-[#EEF0F3]">
                      Chimera++ 2.8.0
                    </div>
                    <div className="text-[13px] text-[#646970] dark:text-[#8D9398]">
                      当前已是最新版本 · 2026 年 10 月发布
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => toast.success("已是最新版本")}
                    className="px-[12px] h-[32px] rounded-[4px] bg-[#006AA0] text-[#FDFDFE] font-medium border-0 cursor-pointer"
                  >
                    检查更新
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 导入模块 (Frame 11) */}
          {activeTab === "import" && (
            <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[16px] justify-start items-start">
              <h2 className="text-[18px]/[23px] m-0 p-0 text-[#12161C] dark:text-[#EEF0F3] font-bold text-left">
                配置导入
              </h2>
              <div className="w-full p-[16px] rounded-[8px] bg-[#F2F4F6] dark:bg-[#1A1E24] border border-[#DDE0E3] dark:border-[#31363D] flex flex-col gap-[8px]">
                <span className="text-[14px] font-bold text-[#12161C] dark:text-[#EEF0F3]">
                  从 cc-switch 导入配置
                </span>
                <span className="text-[13px] text-[#646970] dark:text-[#8D9398]">
                  自动读取 C:\Users\lin\.cc-switch\config.json，逐条确认后导入。
                </span>
                <div className="flex flex-row gap-[8px] mt-[8px]">
                  <button
                    type="button"
                    onClick={() => setCcSwitchImportOpen(true)}
                    className="px-[12px] h-[32px] rounded-[4px] bg-[#006AA0] text-[#FDFDFE] border-0 cursor-pointer text-[13px] font-medium"
                  >
                    开始导入 (12 个供应商)
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Frame 11B 首次启用工具向导弹窗 */}
      {firstEnableModalTool && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#12161C66]">
          <div className="box-border w-[560px] h-fit bg-[#FDFDFE] dark:bg-[#1A1E24] shadow-[0px_12px_28px_#12161C1F] rounded-[8px] p-[24px] flex flex-col gap-[16px]">
            <div className="flex flex-row justify-between items-center border-b border-[#DDE0E3] dark:border-[#31363D] pb-[12px]">
              <div className="flex flex-row items-center gap-[10px]">
                <div className="w-[32px] h-[32px] rounded-[4px] bg-[#12161C] text-[#FDFDFE] flex items-center justify-center font-bold font-mono">
                  {firstEnableModalTool.shortName}
                </div>
                <h3 className="m-0 text-[18px]/[23px] text-[#12161C] dark:text-[#EEF0F3] font-bold">
                  启用 {firstEnableModalTool.name}？
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setFirstEnableModalTool(null)}
                className="w-[28px] h-[28px] flex items-center justify-center border-0 bg-transparent text-[#646970] hover:bg-[#F2F4F6] rounded-[4px] cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <div className="text-[13px]/[18px] text-[#484E55] dark:text-[#BABEC3]">
              已检测到 {firstEnableModalTool.name}{" "}
              {firstEnableModalTool.version || "1.4.2"}
              ，启用后出现在侧栏「其他工具」里。
              <br />
              它是{firstEnableModalTool.categoryLabel}
              ：条目各自启停，没有当前线路。
            </div>

            <div className="box-border w-full p-[12px] rounded-[6px] bg-[#F5F7F9] dark:bg-[#171C21] border border-[#DDE0E3] dark:border-[#31363D] flex flex-col gap-[8px] text-[13px]">
              <div className="flex flex-row justify-between">
                <span className="text-[#646970]">可执行文件：</span>
                <span className="font-mono text-[#12161C] dark:text-[#EEF0F3]">
                  C:\Users\lin\AppData\Roaming\npm\{firstEnableModalTool.id}.cmd
                </span>
              </div>
              <div className="flex flex-row justify-between">
                <span className="text-[#646970]">配置文件：</span>
                <span className="font-mono text-[#12161C] dark:text-[#EEF0F3]">
                  C:\Users\lin\.{firstEnableModalTool.id}\
                  {firstEnableModalTool.id}.json
                </span>
              </div>
              <div className="flex flex-row justify-between">
                <span className="text-[#646970]">先备份到：</span>
                <span className="font-mono text-[#05773B]">
                  %APPDATA%\Chimera\backups\2026-09-27_1424\
                </span>
              </div>
            </div>

            <div className="box-border w-full flex flex-col gap-[6px]">
              <div className="text-[13px] font-bold text-[#12161C] dark:text-[#EEF0F3]">
                {firstEnableModalTool.id}.json 里有 2 个条目，导入为 Chimera++
                条目：
              </div>
              <div className="flex flex-col gap-[4px] pl-[8px] text-[13px] font-mono text-[#484E55] dark:text-[#BABEC3]">
                <div>• api.anthropic.com · claude-sonnet-4-6</div>
                <div>• api.moonshot.cn · kimi-k2.5</div>
              </div>
            </div>

            <div className="text-[12px]/[16px] text-[#646970] dark:text-[#8D9398] bg-[#F2F4F6] dark:bg-[#23282D] p-[8px] rounded-[4px]">
              导入只登记条目，不改动 {firstEnableModalTool.id}.json
              里现有的内容；之后启停条目时才写入，每次写入前都会备份。
            </div>

            <div className="flex flex-row justify-end gap-[8px] pt-[8px]">
              <button
                type="button"
                onClick={() => setFirstEnableModalTool(null)}
                className="px-[12px] h-[32px] rounded-[4px] border border-[#81878D] bg-transparent text-[#12161C] dark:text-[#EEF0F3] text-[13px] cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleConfirmFirstEnable}
                className="px-[16px] h-[32px] rounded-[4px] bg-[#006AA0] text-[#FDFDFE] border-0 text-[13px] font-bold cursor-pointer hover:bg-[#005a88]"
              >
                启用 {firstEnableModalTool.name}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Frame 11D 恢复备份确认弹窗 */}
      {restoreConfirmBackup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#12161C66]">
          <div className="box-border w-[560px] h-fit bg-[#FDFDFE] dark:bg-[#1A1E24] shadow-[0px_12px_28px_#12161C1F] rounded-[8px] p-[24px] flex flex-col gap-[16px]">
            <div className="flex flex-row justify-between items-center border-b border-[#DDE0E3] dark:border-[#31363D] pb-[12px]">
              <div className="flex flex-row items-center gap-[8px] text-[#BE2323]">
                <RotateCcw size={20} />
                <h3 className="m-0 text-[18px]/[23px] text-[#12161C] dark:text-[#EEF0F3] font-bold">
                  恢复 {restoreConfirmBackup.number} 的备份？
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setRestoreConfirmBackup(null)}
                className="w-[28px] h-[28px] flex items-center justify-center border-0 bg-transparent text-[#646970] hover:bg-[#F2F4F6] rounded-[4px] cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <div className="text-[13px]/[18px] text-[#484E55] dark:text-[#BABEC3]">
              会用今天 14:20「切换到 DeepSeek 前」的备份覆盖 config.toml，Codex
              回到当时的线路 OpenAI 官方 · 主力，重启 Codex 后生效。
            </div>

            <div className="box-border w-full p-[12px] rounded-[6px] bg-[#F5F7F9] dark:bg-[#171C21] border border-[#DDE0E3] dark:border-[#31363D] flex flex-col gap-[8px] text-[13px]">
              <div className="flex flex-row justify-between">
                <span className="text-[#BE2323] font-bold">将覆盖：</span>
                <span className="font-mono text-[#12161C] dark:text-[#EEF0F3]">
                  C:\Users\lin\.codex\config.toml（换成 8 KB 历史版本）
                </span>
              </div>
              <div className="flex flex-row justify-between">
                <span className="text-[#05773B] font-bold">撤销保护快照：</span>
                <span className="font-mono text-[#05773B]">
                  ...\backups\2026-09-27_1423\（恢复前先把当前文件备份到这里）
                </span>
              </div>
              <div className="flex flex-row justify-between">
                <span className="text-[#646970]">不改动：</span>
                <span className="text-[#646970]">
                  auth.json、routes.json · 登录与官方账号不受影响
                </span>
              </div>
            </div>

            <div className="flex flex-row justify-end gap-[8px] pt-[8px]">
              <button
                type="button"
                onClick={() => setRestoreConfirmBackup(null)}
                className="px-[12px] h-[32px] rounded-[4px] border border-[#81878D] bg-transparent text-[#12161C] dark:text-[#EEF0F3] text-[13px] cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleConfirmRestore}
                className="px-[16px] h-[32px] rounded-[4px] bg-[#006AA0] text-[#FDFDFE] border-0 text-[13px] font-bold cursor-pointer hover:bg-[#005a88]"
              >
                确认恢复
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Frame 13G 从 cc-switch 导入逐条确认弹窗 */}
      {ccSwitchImportOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#12161C66]">
          <div className="box-border w-[640px] max-h-[700px] bg-[#FDFDFE] dark:bg-[#1A1E24] shadow-[0px_12px_28px_#12161C1F] rounded-[8px] p-[24px] flex flex-col gap-[16px] overflow-hidden">
            <div className="flex flex-row justify-between items-center border-b border-[#DDE0E3] dark:border-[#31363D] pb-[12px]">
              <div className="flex flex-col gap-[2px]">
                <h3 className="m-0 text-[18px]/[23px] text-[#12161C] dark:text-[#EEF0F3] font-bold">
                  从 cc-switch 导入到 Codex 线路？
                </h3>
                <div className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398]">
                  读取 C:\Users\lin\.cc-switch\config.json，共 12
                  个供应商。逐条确认，只写入勾选的项。
                </div>
              </div>
              <button
                type="button"
                onClick={() => setCcSwitchImportOpen(false)}
                className="w-[28px] h-[28px] flex items-center justify-center border-0 bg-transparent text-[#646970] hover:bg-[#F2F4F6] rounded-[4px] cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            {/* 供应商分类表格列表 */}
            <div className="flex-1 overflow-y-auto flex flex-col gap-[12px] pr-[4px]">
              {/* 1. 新增 */}
              <div className="flex flex-col gap-[6px]">
                <div className="text-[13px] font-bold text-[#05773B] flex items-center gap-[6px]">
                  <span>新增 · 3 项</span>
                  <span className="text-[12px] text-[#646970] font-normal">
                    默认勾选导入
                  </span>
                </div>
                {ccSwitchItems
                  .filter((i) => i.category === "new")
                  .map((item) => (
                    <label
                      key={item.id}
                      className="flex flex-row items-center gap-[10px] p-[8px_10px] rounded-[4px] bg-[#F5F7F9] dark:bg-[#23282D] cursor-pointer hover:bg-[#ECEFF2]"
                    >
                      <input
                        type="checkbox"
                        checked={item.checked}
                        onChange={() => handleToggleCcSwitchItem(item.id)}
                        className="rounded"
                      />
                      <div className="flex-1 flex flex-col gap-[1px]">
                        <span className="text-[13px] font-bold text-[#12161C] dark:text-[#EEF0F3]">
                          {item.name}
                        </span>
                        <span className="text-[12px] text-[#646970] font-mono">
                          {item.endpoint} · {item.model}
                        </span>
                      </div>
                    </label>
                  ))}
              </div>

              {/* 2. 与现有相同 */}
              <div className="flex flex-col gap-[6px]">
                <div className="text-[13px] font-bold text-[#646970] flex items-center gap-[6px]">
                  <span>与现有相同 · 4 项</span>
                  <span className="text-[12px] text-[#8D9398] font-normal">
                    跳过，不写入
                  </span>
                </div>
                {ccSwitchItems
                  .filter((i) => i.category === "identical")
                  .map((item) => (
                    <div
                      key={item.id}
                      className="flex flex-row items-center gap-[10px] p-[6px_10px] rounded-[4px] opacity-60 text-[13px]"
                    >
                      <span className="w-[16px] text-center text-[#646970]">
                        •
                      </span>
                      <span className="text-[#12161C] dark:text-[#EEF0F3]">
                        {item.name}
                      </span>
                      <span className="text-[#646970] font-mono text-[12px]">
                        {item.endpoint}
                      </span>
                    </div>
                  ))}
              </div>

              {/* 3. 冲突 */}
              <div className="flex flex-col gap-[6px]">
                <div className="text-[13px] font-bold text-[#915C08] flex items-center gap-[6px]">
                  <span>冲突 · 2 项</span>
                  <span className="text-[12px] text-[#8D9398] font-normal">
                    默认保留现有配置
                  </span>
                </div>
                {ccSwitchItems
                  .filter((i) => i.category === "conflict")
                  .map((item) => (
                    <div
                      key={item.id}
                      className="flex flex-col gap-[2px] p-[8px_10px] rounded-[4px] bg-[#FEF3C7]/40 dark:bg-[#78350F]/20 text-[13px]"
                    >
                      <div className="font-bold text-[#12161C] dark:text-[#EEF0F3]">
                        {item.name}
                      </div>
                      <div className="text-[12px] text-[#915C08]">
                        {item.description}
                      </div>
                    </div>
                  ))}
              </div>

              {/* 4. 不支持 */}
              <div className="flex flex-col gap-[6px]">
                <div className="text-[13px] font-bold text-[#BE2323] flex items-center gap-[6px]">
                  <span>不支持 · 3 项</span>
                  <span className="text-[12px] text-[#8D9398] font-normal">
                    只列出，不导入
                  </span>
                </div>
                {ccSwitchItems
                  .filter((i) => i.category === "unsupported")
                  .map((item) => (
                    <div
                      key={item.id}
                      className="flex flex-col gap-[2px] p-[6px_10px] rounded-[4px] text-[13px] opacity-75"
                    >
                      <div className="font-medium text-[#12161C] dark:text-[#EEF0F3]">
                        {item.name}
                      </div>
                      <div className="text-[12px] text-[#646970]">
                        {item.description}
                      </div>
                    </div>
                  ))}
              </div>
            </div>

            <div className="text-[12px]/[16px] text-[#646970] dark:text-[#8D9398] border-t border-[#DDE0E3] dark:border-[#31363D] pt-[12px]">
              写入 routes.json；导入前备份到 …\backups\2026-09-27_1424\；不改动
              config.toml。
            </div>

            <div className="flex flex-row justify-end gap-[8px]">
              <button
                type="button"
                onClick={() => setCcSwitchImportOpen(false)}
                className="px-[12px] h-[32px] rounded-[4px] border border-[#81878D] bg-transparent text-[#12161C] dark:text-[#EEF0F3] text-[13px] cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleConfirmCcSwitchImport}
                className="px-[16px] h-[32px] rounded-[4px] bg-[#006AA0] text-[#FDFDFE] border-0 text-[13px] font-bold cursor-pointer hover:bg-[#005a88]"
              >
                导入勾选的项
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default SettingsView;
