import React, { useState } from "react";
import { toast } from "sonner";
import { FolderOpen } from "lucide-react";
import { CANONICAL_SESSIONS } from "@/data/canonicalData";

interface SessionsViewProps {
  appId?: string;
}

export const SessionsView: React.FC<SessionsViewProps> = () => {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    new Set(["0199a3f2-7c41", "0199a2e1-4b12"]),
  );
  const [activeSessionId, setActiveSessionId] =
    useState<string>("0199a3f2-7c41");
  const [searchQuery, setSearchQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const [toolFilter, setToolFilter] = useState<string>("Codex");
  const [routeFilter, setRouteFilter] = useState<string>("全部");
  const [timeFilter, setTimeFilter] = useState<string>("近 7 天");
  const [openDropdown, setOpenDropdown] = useState<
    "tool" | "route" | "time" | null
  >(null);

  const activeSession =
    CANONICAL_SESSIONS.find((s) => s.id === activeSessionId) ||
    CANONICAL_SESSIONS[0];

  const handleToggleSelect = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCopyResume = () => {
    if (!activeSession) return;
    navigator.clipboard.writeText(activeSession.resumeCmd);
    setCopied(true);
    toast.success("已复制恢复命令到剪贴板");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleExportSelected = () => {
    if (selectedIds.size === 0) {
      toast.info("请先勾选需要导出的会话");
      return;
    }
    toast.success(`正在导出选中的 ${selectedIds.size} 条会话…`);
  };

  const handleDeleteSelected = () => {
    if (selectedIds.size === 0) {
      toast.info("请先勾选需要删除的会话");
      return;
    }
    toast.info(`确定删除选中的 ${selectedIds.size} 条会话吗？可在确认框中操作`);
  };

  // 针对过滤条件计算会话列表
  const isGeminiCLIEmpty =
    toolFilter === "Gemini CLI" && timeFilter === "近 7 天";

  // Group sessions by dateGroup
  const groupedSessions = isGeminiCLIEmpty
    ? {}
    : CANONICAL_SESSIONS.reduce(
        (acc, sess) => {
          if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase();
            if (!sess.title.toLowerCase().includes(q) && !sess.id.includes(q))
              return acc;
          }
          if (routeFilter !== "全部" && !sess.lineName.includes(routeFilter)) {
            return acc;
          }
          const group = sess.dateGroup || "其他";
          if (!acc[group]) acc[group] = [];
          acc[group].push(sess);
          return acc;
        },
        {} as Record<string, typeof CANONICAL_SESSIONS>,
      );

  return (
    <div
      data-pencil-name="内容"
      className="[box-sizing:content-box] w-full flex-1 flex flex-col gap-[12px] p-[12px_24px] justify-start items-start bg-[#FDFDFE] [border-width:1px_0px_0px_1px] [border-style:solid] [border-color:#00000000] h-full overflow-hidden"
    >
      {/* 1. Page Header */}
      <div
        data-pencil-name="页头"
        className="box-border w-full h-fit shrink-0 flex flex-row gap-[12px] justify-start items-center"
      >
        <div
          data-pencil-name="标题区"
          className="box-border [flex:1_1_0] h-fit flex flex-col gap-[2px] justify-start items-start"
        >
          <div
            data-pencil-name="标题行"
            className="box-border w-fit h-fit shrink-0 flex flex-row gap-[10px] justify-start items-center"
          >
            <div
              data-pencil-name="标题"
              className="text-[28px]/[36px] box-border text-[#12161C] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold text-left whitespace-nowrap"
            >
              会话
            </div>
          </div>
          <div
            data-pencil-name="说明"
            className="text-[13px]/[18px] box-border text-[#646970] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal text-left whitespace-nowrap"
          >
            所有工具的会话都在这里 · 导出与删除前会先确认
          </div>
        </div>
        <div
          data-pencil-name="操作"
          className="box-border w-fit shrink-0 h-fit flex flex-row gap-[8px] justify-start items-center"
        >
          <button
            onClick={handleExportSelected}
            data-pencil-name="次要一"
            className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] p-[0px_12px] justify-center items-center bg-[#FDFDFE] [outline:1px_solid_#81878D] [outline-offset:-0.5px] rounded-[4px] cursor-pointer hover:bg-[#F2F4F6]"
          >
            <svg
              viewBox="0 0 14 14"
              className="box-border w-[16px] shrink-0 h-[16px]"
              fill="#12161C"
            >
              <path d="M4.375 3.5q-0.10938-0.16406-0.10938-0.32813 0-0.16406 0.10938-0.32812l2.29688-2.29688q0.16406-0.10938 0.32812-0.10937 0.16406 0 0.32813 0.10937l2.29687 2.29688q0.10938 0.16406 0.10938 0.32813 0 0.16406-0.13672 0.30078-0.13672 0.13672-0.30078 0.13672-0.16406 0-0.32813-0.10938l-1.53125-1.58594 0 5.08594q0 0.16406-0.13672 0.30078-0.13672 0.13672-0.30078 0.13672-0.16406 0-0.30078-0.13672-0.13672-0.13672-0.13672-0.30078l0-5.08594-1.53125 1.58594q-0.16406 0.10938-0.32813 0.10938-0.16406 0-0.32812-0.10938z m6.5625 1.3125l-1.3125 0q-0.16406 0-0.30078 0.13672-0.13672 0.13672-0.13672 0.30078 0 0.16406 0.13672 0.30078 0.13672 0.13672 0.30078 0.13672l1.3125 0 0 5.6875-7.875 0 0-5.6875 1.3125 0q0.16406 0 0.30078-0.13672 0.13672-0.13672 0.13672-0.30078 0-0.16406-0.13672-0.30078-0.13672-0.13672-0.30078-0.13672l-1.3125 0q-0.38281 0-0.62891 0.24609-0.24609 0.24609-0.24609 0.62891l0 5.6875q0 0.38281 0.24609 0.62891 0.24609 0.24609 0.62891 0.24609l7.875 0q0.38281 0 0.62891-0.24609 0.24609-0.24609 0.24609-0.62891l0-5.6875q0-0.38281-0.24609-0.62891-0.24609-0.24609-0.62891-0.24609z" />
            </svg>
            <div className="text-[14px]/[20px] box-border text-[#12161C] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal text-left whitespace-nowrap">
              导出所选
            </div>
          </button>

          <button
            onClick={handleDeleteSelected}
            data-pencil-name="次要二"
            className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] p-[0px_12px] justify-center items-center bg-[#FDFDFE] [outline:1px_solid_#81878D] [outline-offset:-0.5px] rounded-[4px] cursor-pointer hover:bg-[#F2F4F6]"
          >
            <svg
              viewBox="0 0 14 14"
              className="box-border w-[16px] shrink-0 h-[16px]"
              fill="#BE2323"
            >
              <path d="M11.8125 2.625l-2.1875 0 0-0.4375q0-0.54688-0.38281-0.92969-0.38281-0.38281-0.92969-0.38281l-2.625 0q-0.54688 0-0.92969 0.38281-0.38281 0.38281-0.38281 0.92969l0 0.4375-2.1875 0q-0.16406 0-0.30078 0.13672-0.13672 0.13672-0.13672 0.30078 0 0.16406 0.13672 0.30078 0.13672 0.13672 0.30078 0.13672l0.4375 0 0 7.875q0 0.38281 0.24609 0.62891 0.24609 0.24609 0.62891 0.24609l7 0q0.38281 0 0.62891-0.24609 0.24609-0.24609 0.24609-0.62891l0-7.875 0.4375 0q0.16406 0 0.30078-0.13672 0.13672-0.13672 0.13672-0.30078 0-0.16406-0.13672-0.30078-0.13672-0.13672-0.30078-0.13672z m-6.5625-0.4375q0-0.16406 0.13672-0.30078 0.13672-0.13672 0.30078-0.13672l2.625 0q0.16406 0 0.30078 0.13672 0.13672 0.13672 0.13672 0.30078l0 0.4375-3.5 0 0-0.4375z m5.25 9.1875l-7 0 0-7.875 7 0 0 7.875z m-4.375-5.6875l0 3.5q0 0.16406-0.13672 0.30078-0.13672 0.13672-0.30078 0.13672-0.16406 0-0.30078-0.13672-0.13672-0.13672-0.13672-0.30078l0-3.5q0-0.16406 0.13672-0.30078 0.13672-0.13672 0.30078-0.13672 0.16406 0 0.30078 0.13672 0.13672 0.13672 0.13672 0.30078z m2.625 0l0 3.5q0 0.16406-0.13672 0.30078-0.13672 0.13672-0.30078 0.13672-0.16406 0-0.30078-0.13672-0.13672-0.13672-0.13672-0.30078l0-3.5q0-0.16406 0.13672-0.30078 0.13672-0.13672 0.30078-0.13672 0.16406 0 0.30078 0.13672 0.13672 0.13672 0.13672 0.30078z" />
            </svg>
            <div className="text-[14px]/[20px] box-border text-[#BE2323] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal text-left whitespace-nowrap">
              删除所选
            </div>
          </button>
        </div>
      </div>

      {/* 2. Summary Row */}
      <div
        data-pencil-name="摘要行 · 会话"
        className="box-border w-full h-fit shrink-0 flex flex-row gap-[12px] justify-start items-center"
      >
        <div className="box-border w-fit shrink-0 h-fit flex flex-row gap-[6px] justify-start items-center">
          <span className="text-[13px]/[18px] text-[#484E55] font-['Noto_Sans_SC',system-ui,sans-serif]">
            本机会话
          </span>
          <span className="text-[13px]/[18px] text-[#12161C] font-[Overpass,system-ui,sans-serif] font-bold">
            1284 条
          </span>
        </div>
        <div className="box-border w-[1px] shrink-0 h-[12px] bg-[#DDE0E3]" />
        <div className="box-border w-fit shrink-0 h-fit flex flex-row gap-[6px] justify-start items-center">
          <span className="text-[13px]/[18px] text-[#484E55] font-['Noto_Sans_SC',system-ui,sans-serif]">
            工具
          </span>
          <span className="text-[13px]/[18px] text-[#12161C] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold">
            4 个
          </span>
        </div>
        <div className="box-border w-[1px] shrink-0 h-[12px] bg-[#DDE0E3]" />
        <div className="box-border w-fit shrink-0 h-fit flex flex-row gap-[6px] justify-start items-center">
          <span className="text-[13px]/[18px] text-[#484E55] font-['Noto_Sans_SC',system-ui,sans-serif]">
            {toolFilter === "Gemini CLI" ? "Gemini CLI" : "Codex"}
          </span>
          <span className="text-[13px]/[18px] text-[#12161C] font-[Overpass,system-ui,sans-serif] font-bold">
            {toolFilter === "Gemini CLI" ? "64" : "862"}
          </span>
        </div>
        <div className="box-border w-[1px] shrink-0 h-[12px] bg-[#DDE0E3]" />
        <div className="box-border w-fit shrink-0 h-fit flex flex-row gap-[6px] justify-start items-center">
          <span className="text-[13px]/[18px] text-[#484E55] font-['Noto_Sans_SC',system-ui,sans-serif]">
            近 7 天
          </span>
          <span className="text-[13px]/[18px] text-[#12161C] font-[Overpass,system-ui,sans-serif] font-bold">
            {isGeminiCLIEmpty ? "0 条" : "96 条"}
          </span>
        </div>
        <div className="box-border w-[1px] shrink-0 h-[12px] bg-[#DDE0E3]" />
        <div className="box-border w-fit shrink-0 h-fit flex flex-row gap-[6px] justify-start items-center">
          <span className="text-[13px]/[18px] text-[#484E55] font-['Noto_Sans_SC',system-ui,sans-serif]">
            索引
          </span>
          <span className="text-[13px]/[18px] text-[#12161C] font-[Overpass,system-ui,sans-serif] font-bold">
            14:22
          </span>
        </div>
      </div>

      {/* Frame 13A: Gemini CLI 近 7 天没有会话记录 空状态 */}
      {isGeminiCLIEmpty ? (
        <div className="w-full flex-1 flex flex-col gap-[16px] justify-start items-start">
          {/* 筛选工具栏 */}
          <div className="w-full flex flex-row gap-[12px] items-center">
            {/* Search bar */}
            <div
              data-pencil-name="搜索"
              className="box-border w-[380px] h-[32px] shrink-0 flex flex-row gap-[8px] p-[0px_6px_0px_10px] justify-start items-center bg-[#FDFDFE] [outline:1px_solid_#81878D] [outline-offset:-0.5px] rounded-[4px]"
            >
              <svg
                viewBox="0 0 14 14"
                className="w-[14px] shrink-0 h-[14px]"
                fill="#646970"
              >
                <path d="M12.57813 11.92188l-2.40625-2.35157q0.875-1.03906 1.12109-2.29687 0.24609-1.25781-0.16406-2.51563-0.41016-1.25781-1.39453-2.16015-0.98438-0.90234-2.24219-1.17578-1.25781-0.27344-2.51563 0.05468-1.25781 0.32813-2.21484 1.28516-0.95703 0.95703-1.28516 2.21484-0.32813 1.25781-0.05468 2.51563 0.27344 1.25781 1.17578 2.24219 0.90234 0.98438 2.16015 1.39453 1.25781 0.41016 2.51563 0.16406 1.25781-0.24609 2.29687-1.12109l2.35157 2.40625q0.16406 0.10938 0.32812 0.10937 0.16406 0 0.30078-0.13672 0.13672-0.13672 0.13672-0.30078 0-0.16406-0.10937-0.32812z m-10.39063-5.57813q0-1.14844 0.54688-2.10547 0.54688-0.95703 1.5039-1.50391 0.95703-0.54688 2.10547-0.54687 1.14844 0 2.10547 0.54688 0.95703 0.54688 1.50391 1.5039 0.54688 0.95703 0.54687 2.10547 0 1.14844-0.54688 2.10547-0.54688 0.95703-1.5039 1.50391-0.95703 0.54688-2.10547 0.54687-1.14844 0-2.10547-0.54688-0.95703-0.54688-1.50391-1.5039-0.54688-0.95703-0.54687-2.10547z" />
              </svg>
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索标题、项目、线路或会话 ID"
                className="text-[14px]/[20px] box-border [flex:1_1_0] text-[#12161C] font-['Noto_Sans_SC',system-ui,sans-serif] bg-transparent outline-none border-none placeholder-[#646970]"
              />
              <div className="box-border w-fit shrink-0 h-[20px] flex flex-row gap-0 p-[0px_6px] justify-start items-center bg-[#FDFDFE] [outline:1px_solid_#DDE0E3] [outline-offset:-0.5px] rounded-[4px]">
                <span className="text-[12px]/[17px] text-[#646970] font-[Overpass,system-ui,sans-serif]">
                  Ctrl F
                </span>
              </div>
            </div>

            {/* Filter Dropdowns */}
            <div className="relative">
              <button
                type="button"
                onClick={() =>
                  setOpenDropdown(openDropdown === "tool" ? null : "tool")
                }
                className="box-border w-fit shrink-0 h-[28px] flex flex-row gap-[4px] p-[0px_8px_0px_10px] justify-start items-center bg-[#FDFDFE] [outline:1px_solid_#81878D] [outline-offset:-0.5px] rounded-[4px] cursor-pointer"
              >
                <span className="text-[13px]/[18px] text-[#12161C] font-['Noto_Sans_SC',system-ui,sans-serif]">
                  工具：{toolFilter}
                </span>
                <svg
                  viewBox="0 0 14 14"
                  className="w-[12px] h-[12px]"
                  fill="#484E55"
                >
                  <path d="M7 10.0625q-0.16406 0-0.32813-0.10938l-4.375-4.375q-0.10938-0.16406-0.08203-0.32812 0.02734-0.16406 0.13672-0.27344 0.10938-0.10938 0.27344-0.13672 0.16406-0.02734 0.32812 0.08203l4.04688 4.10157 4.04688-4.10156q0.16406-0.10938 0.32812-0.08204 0.16406 0.02734 0.27344 0.13672 0.10937 0.10938 0.13672 0.27344 0.02734 0.16406-0.08203 0.32813l-4.375 4.375q-0.16406 0.10938-0.32813 0.10937z" />
                </svg>
              </button>
              {openDropdown === "tool" && (
                <div className="absolute top-[32px] left-0 z-50 bg-[#FDFDFE] shadow-lg rounded-[4px] border border-[#DDE0E3] p-1 flex flex-col min-w-[120px]">
                  {[
                    "Codex",
                    "Gemini CLI",
                    "Claude Code",
                    "OpenCode",
                    "全部",
                  ].map((t) => (
                    <button
                      key={t}
                      onClick={() => {
                        setToolFilter(t);
                        setOpenDropdown(null);
                      }}
                      className="px-3 py-1.5 text-left text-[13px] hover:bg-[#F2F4F6] rounded text-[#12161C] border-none bg-transparent cursor-pointer"
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="relative">
              <button
                type="button"
                onClick={() =>
                  setOpenDropdown(openDropdown === "route" ? null : "route")
                }
                className="box-border w-fit shrink-0 h-[28px] flex flex-row gap-[4px] p-[0px_8px_0px_10px] justify-start items-center bg-[#FDFDFE] [outline:1px_solid_#81878D] [outline-offset:-0.5px] rounded-[4px] cursor-pointer"
              >
                <span className="text-[13px]/[18px] text-[#12161C] font-['Noto_Sans_SC',system-ui,sans-serif]">
                  线路：{routeFilter}
                </span>
                <svg
                  viewBox="0 0 14 14"
                  className="w-[12px] h-[12px]"
                  fill="#484E55"
                >
                  <path d="M7 10.0625q-0.16406 0-0.32813-0.10938l-4.375-4.375q-0.10938-0.16406-0.08203-0.32812 0.02734-0.16406 0.13672-0.27344 0.10938-0.10938 0.27344-0.13672 0.16406-0.02734 0.32812 0.08203l4.04688 4.10157 4.04688-4.10156q0.16406-0.10938 0.32812-0.08204 0.16406 0.02734 0.27344 0.13672 0.10937 0.10938 0.13672 0.27344 0.02734 0.16406-0.08203 0.32813l-4.375 4.375q-0.16406 0.10938-0.32813 0.10937z" />
                </svg>
              </button>
              {openDropdown === "route" && (
                <div className="absolute top-[32px] left-0 z-50 bg-[#FDFDFE] shadow-lg rounded-[4px] border border-[#DDE0E3] p-1 flex flex-col min-w-[140px]">
                  {[
                    "全部",
                    "OpenAI 官方 · 主力",
                    "DeepSeek",
                    "Kimi",
                    "智谱 GLM",
                  ].map((r) => (
                    <button
                      key={r}
                      onClick={() => {
                        setRouteFilter(r);
                        setOpenDropdown(null);
                      }}
                      className="px-3 py-1.5 text-left text-[13px] hover:bg-[#F2F4F6] rounded text-[#12161C] border-none bg-transparent cursor-pointer"
                    >
                      {r}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="relative">
              <button
                type="button"
                onClick={() =>
                  setOpenDropdown(openDropdown === "time" ? null : "time")
                }
                className="box-border w-fit shrink-0 h-[28px] flex flex-row gap-[4px] p-[0px_8px_0px_10px] justify-start items-center bg-[#FDFDFE] [outline:1px_solid_#81878D] [outline-offset:-0.5px] rounded-[4px] cursor-pointer"
              >
                <span className="text-[13px]/[18px] text-[#12161C] font-['Noto_Sans_SC',system-ui,sans-serif]">
                  {timeFilter}
                </span>
                <svg
                  viewBox="0 0 14 14"
                  className="w-[12px] h-[12px]"
                  fill="#484E55"
                >
                  <path d="M7 10.0625q-0.16406 0-0.32813-0.10938l-4.375-4.375q-0.10938-0.16406-0.08203-0.32812 0.02734-0.16406 0.13672-0.27344 0.10938-0.10938 0.27344-0.13672 0.16406-0.02734 0.32812 0.08203l4.04688 4.10157 4.04688-4.10156q0.16406-0.10938 0.32812-0.08204 0.16406 0.02734 0.27344 0.13672 0.10937 0.10938 0.13672 0.27344 0.02734 0.16406-0.08203 0.32813l-4.375 4.375q-0.16406 0.10938-0.32813 0.10937z" />
                </svg>
              </button>
              {openDropdown === "time" && (
                <div className="absolute top-[32px] left-0 z-50 bg-[#FDFDFE] shadow-lg rounded-[4px] border border-[#DDE0E3] p-1 flex flex-col min-w-[100px]">
                  {["近 7 天", "近 30 天", "全部"].map((t) => (
                    <button
                      key={t}
                      onClick={() => {
                        setTimeFilter(t);
                        setOpenDropdown(null);
                      }}
                      className="px-3 py-1.5 text-left text-[13px] hover:bg-[#F2F4F6] rounded text-[#12161C] border-none bg-transparent cursor-pointer"
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 13A 空区 */}
          <div
            data-pencil-name="空区"
            className="w-full flex-1 flex flex-col justify-center items-center pb-[64px]"
          >
            <div
              data-pencil-name="空状态 · Gemini CLI"
              className="w-[440px] flex flex-col items-center gap-[16px] text-center"
            >
              <div className="text-[16px]/[22px] font-bold text-[#12161C] font-['Noto_Sans_SC',system-ui,sans-serif]">
                Gemini CLI 近 7 天没有会话记录
              </div>
              <div className="text-[13px]/[18px] text-[#646970] font-['Noto_Sans_SC',system-ui,sans-serif] whitespace-pre-line">
                共有 64 条会话，最近一次在 9 月 12 日。{"\n"}
                会话目录：C:\Users\lin\.gemini\tmp\
              </div>
              <div className="flex flex-row gap-[12px] justify-center items-center mt-2">
                <button
                  type="button"
                  onClick={() => setTimeFilter("全部")}
                  className="h-[32px] px-[16px] flex items-center justify-center bg-[#12161C] text-[#FDFDFE] rounded-[4px] text-[13px] font-bold cursor-pointer hover:bg-[#2A2F37] transition-colors border-none"
                >
                  清除时间筛选
                </button>
                <button
                  type="button"
                  onClick={() =>
                    toast.info("已打开会话目录: C:\\Users\\lin\\.gemini\\tmp\\")
                  }
                  className="h-[32px] px-[12px] flex items-center gap-[6px] justify-center bg-[#FDFDFE] [outline:1px_solid_#81878D] [outline-offset:-0.5px] text-[#12161C] rounded-[4px] text-[13px] cursor-pointer hover:bg-[#F2F4F6] transition-colors border-none"
                >
                  <FolderOpen size={15} />
                  <span>打开会话目录</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* 3. Main Two-Column Layout */
        <div
          data-pencil-name="两栏"
          className="box-border w-full flex-1 flex flex-row gap-[24px] justify-start items-start overflow-hidden"
        >
          {/* Left Column: 380px Sessions List */}
          <div
            data-pencil-name="列表栏"
            className="box-border w-[380px] shrink-0 h-full flex flex-col gap-[10px] justify-start items-start overflow-hidden"
          >
            {/* Search bar */}
            <div
              data-pencil-name="搜索"
              className="box-border w-full h-[32px] shrink-0 flex flex-row gap-[8px] p-[0px_6px_0px_10px] justify-start items-center bg-[#FDFDFE] [outline:1px_solid_#81878D] [outline-offset:-0.5px] rounded-[4px]"
            >
              <svg
                viewBox="0 0 14 14"
                className="box-border w-[14px] shrink-0 h-[14px]"
                fill="#646970"
              >
                <path d="M12.57813 11.92188l-2.40625-2.35157q0.875-1.03906 1.12109-2.29687 0.24609-1.25781-0.16406-2.51563-0.41016-1.25781-1.39453-2.16015-0.98438-0.90234-2.24219-1.17578-1.25781-0.27344-2.51563 0.05468-1.25781 0.32813-2.21484 1.28516-0.95703 0.95703-1.28516 2.21484-0.32813 1.25781-0.05468 2.51563 0.27344 1.25781 1.17578 2.24219 0.90234 0.98438 2.16015 1.39453 1.25781 0.41016 2.51563 0.16406 1.25781-0.24609 2.29687-1.12109l2.35157 2.40625q0.16406 0.10938 0.32812 0.10937 0.16406 0 0.30078-0.13672 0.13672-0.13672 0.13672-0.30078 0-0.16406-0.10937-0.32812z m-10.39063-5.57813q0-1.14844 0.54688-2.10547 0.54688-0.95703 1.5039-1.50391 0.95703-0.54688 2.10547-0.54687 1.14844 0 2.10547 0.54688 0.95703 0.54688 1.50391 1.5039 0.54688 0.95703 0.54687 2.10547 0 1.14844-0.54688 2.10547-0.54688 0.95703-1.5039 1.50391-0.95703 0.54688-2.10547 0.54687-1.14844 0-2.10547-0.54688-0.95703-0.54688-1.50391-1.5039-0.54688-0.95703-0.54687-2.10547z" />
              </svg>
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索标题、项目、线路或会话 ID"
                className="text-[14px]/[20px] box-border [flex:1_1_0] text-[#12161C] font-['Noto_Sans_SC',system-ui,sans-serif] bg-transparent outline-none border-none placeholder-[#646970]"
              />
              <div className="box-border w-fit shrink-0 h-[20px] flex flex-row gap-0 p-[0px_6px] justify-start items-center bg-[#FDFDFE] [outline:1px_solid_#DDE0E3] [outline-offset:-0.5px] rounded-[4px]">
                <span className="text-[12px]/[17px] text-[#646970] font-[Overpass,system-ui,sans-serif]">
                  Ctrl F
                </span>
              </div>
            </div>

            {/* Filter Dropdowns */}
            <div className="box-border w-full h-fit shrink-0 flex flex-row gap-[8px] justify-start items-center">
              <div className="relative">
                <button
                  type="button"
                  onClick={() =>
                    setOpenDropdown(openDropdown === "tool" ? null : "tool")
                  }
                  className="box-border w-fit shrink-0 h-[28px] flex flex-row gap-[4px] p-[0px_8px_0px_10px] justify-start items-center bg-[#FDFDFE] [outline:1px_solid_#81878D] [outline-offset:-0.5px] rounded-[4px] cursor-pointer"
                >
                  <span className="text-[13px]/[18px] text-[#12161C] font-['Noto_Sans_SC',system-ui,sans-serif]">
                    工具：{toolFilter}
                  </span>
                  <svg
                    viewBox="0 0 14 14"
                    className="w-[12px] h-[12px]"
                    fill="#484E55"
                  >
                    <path d="M7 10.0625q-0.16406 0-0.32813-0.10938l-4.375-4.375q-0.10938-0.16406-0.08203-0.32812 0.02734-0.16406 0.13672-0.27344 0.10938-0.10938 0.27344-0.13672 0.16406-0.02734 0.32812 0.08203l4.04688 4.10157 4.04688-4.10156q0.16406-0.10938 0.32812-0.08204 0.16406 0.02734 0.27344 0.13672 0.10937 0.10938 0.13672 0.27344 0.02734 0.16406-0.08203 0.32813l-4.375 4.375q-0.16406 0.10938-0.32813 0.10937z" />
                  </svg>
                </button>
                {openDropdown === "tool" && (
                  <div className="absolute top-[32px] left-0 z-50 bg-[#FDFDFE] shadow-lg rounded-[4px] border border-[#DDE0E3] p-1 flex flex-col min-w-[120px]">
                    {[
                      "Codex",
                      "Gemini CLI",
                      "Claude Code",
                      "OpenCode",
                      "全部",
                    ].map((t) => (
                      <button
                        key={t}
                        onClick={() => {
                          setToolFilter(t);
                          setOpenDropdown(null);
                        }}
                        className="px-3 py-1.5 text-left text-[13px] hover:bg-[#F2F4F6] rounded text-[#12161C] border-none bg-transparent cursor-pointer"
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="relative">
                <button
                  type="button"
                  onClick={() =>
                    setOpenDropdown(openDropdown === "route" ? null : "route")
                  }
                  className="box-border w-fit shrink-0 h-[28px] flex flex-row gap-[4px] p-[0px_8px_0px_10px] justify-start items-center bg-[#FDFDFE] [outline:1px_solid_#81878D] [outline-offset:-0.5px] rounded-[4px] cursor-pointer"
                >
                  <span className="text-[13px]/[18px] text-[#12161C] font-['Noto_Sans_SC',system-ui,sans-serif]">
                    线路：{routeFilter}
                  </span>
                  <svg
                    viewBox="0 0 14 14"
                    className="w-[12px] h-[12px]"
                    fill="#484E55"
                  >
                    <path d="M7 10.0625q-0.16406 0-0.32813-0.10938l-4.375-4.375q-0.10938-0.16406-0.08203-0.32812 0.02734-0.16406 0.13672-0.27344 0.10938-0.10938 0.27344-0.13672 0.16406-0.02734 0.32812 0.08203l4.04688 4.10157 4.04688-4.10156q0.16406-0.10938 0.32812-0.08204 0.16406 0.02734 0.27344 0.13672 0.10937 0.10938 0.13672 0.27344 0.02734 0.16406-0.08203 0.32813l-4.375 4.375q-0.16406 0.10938-0.32813 0.10937z" />
                  </svg>
                </button>
                {openDropdown === "route" && (
                  <div className="absolute top-[32px] left-0 z-50 bg-[#FDFDFE] shadow-lg rounded-[4px] border border-[#DDE0E3] p-1 flex flex-col min-w-[140px]">
                    {[
                      "全部",
                      "OpenAI 官方 · 主力",
                      "DeepSeek",
                      "Kimi",
                      "智谱 GLM",
                    ].map((r) => (
                      <button
                        key={r}
                        onClick={() => {
                          setRouteFilter(r);
                          setOpenDropdown(null);
                        }}
                        className="px-3 py-1.5 text-left text-[13px] hover:bg-[#F2F4F6] rounded text-[#12161C] border-none bg-transparent cursor-pointer"
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="relative">
                <button
                  type="button"
                  onClick={() =>
                    setOpenDropdown(openDropdown === "time" ? null : "time")
                  }
                  className="box-border w-fit shrink-0 h-[28px] flex flex-row gap-[4px] p-[0px_8px_0px_10px] justify-start items-center bg-[#FDFDFE] [outline:1px_solid_#81878D] [outline-offset:-0.5px] rounded-[4px] cursor-pointer"
                >
                  <span className="text-[13px]/[18px] text-[#12161C] font-['Noto_Sans_SC',system-ui,sans-serif]">
                    {timeFilter}
                  </span>
                  <svg
                    viewBox="0 0 14 14"
                    className="w-[12px] h-[12px]"
                    fill="#484E55"
                  >
                    <path d="M7 10.0625q-0.16406 0-0.32813-0.10938l-4.375-4.375q-0.10938-0.16406-0.08203-0.32812 0.02734-0.16406 0.13672-0.27344 0.10938-0.10938 0.27344-0.13672 0.16406-0.02734 0.32812 0.08203l4.04688 4.10157 4.04688-4.10156q0.16406-0.10938 0.32812-0.08204 0.16406 0.02734 0.27344 0.13672 0.10937 0.10938 0.13672 0.27344 0.02734 0.16406-0.08203 0.32813l-4.375 4.375q-0.16406 0.10938-0.32813 0.10937z" />
                  </svg>
                </button>
                {openDropdown === "time" && (
                  <div className="absolute top-[32px] left-0 z-50 bg-[#FDFDFE] shadow-lg rounded-[4px] border border-[#DDE0E3] p-1 flex flex-col min-w-[100px]">
                    {["近 7 天", "近 30 天", "全部"].map((t) => (
                      <button
                        key={t}
                        onClick={() => {
                          setTimeFilter(t);
                          setOpenDropdown(null);
                        }}
                        className="px-3 py-1.5 text-left text-[13px] hover:bg-[#F2F4F6] rounded text-[#12161C] border-none bg-transparent cursor-pointer"
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Selection indicator bar */}
            <div className="box-border w-full h-[28px] shrink-0 flex flex-row gap-[8px] p-[0px_12px] justify-start items-center bg-[#F2F4F6] rounded-[4px]">
              <span className="text-[13px]/[18px] flex-1 text-[#12161C] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold">
                已选 {selectedIds.size} 条
              </span>
              <button
                onClick={() => setSelectedIds(new Set())}
                className="text-[13px]/[18px] text-[#484E55] font-['Noto_Sans_SC',system-ui,sans-serif] hover:text-[#12161C] cursor-pointer border-none bg-transparent"
              >
                取消选择
              </button>
            </div>

            {/* Grouped Sessions List */}
            <div className="box-border w-full flex-1 overflow-y-auto flex flex-col gap-0 justify-start items-start">
              {Object.entries(groupedSessions).map(([date, list]) => (
                <React.Fragment key={date}>
                  <div className="box-border w-full h-[28px] shrink-0 flex flex-row gap-0 p-[4px_12px_0px_12px] justify-start items-center">
                    <span className="text-[13px]/[18px] text-[#646970] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold">
                      {date}
                    </span>
                  </div>
                  {list.map((sess) => {
                    const isChecked = selectedIds.has(sess.id);
                    const isActive = sess.id === activeSessionId;
                    const markText = sess.lineName.includes("主力")
                      ? "主"
                      : sess.lineName.includes("Kimi")
                        ? "Ki"
                        : sess.lineName.includes("OpenRouter")
                          ? "OR"
                          : "DS";
                    const badgeBg = sess.lineName.includes("主力")
                      ? "#1A1E24"
                      : sess.lineName.includes("Kimi")
                        ? "#776894"
                        : sess.lineName.includes("OpenRouter")
                          ? "#8F607A"
                          : "#537197";

                    return (
                      <div
                        key={sess.id}
                        onClick={() => setActiveSessionId(sess.id)}
                        className={`box-border w-full h-[64px] shrink-0 flex flex-row gap-[10px] p-[0px_12px_0px_4px] justify-start items-center rounded-[4px] cursor-pointer ${
                          isActive
                            ? "bg-[#E7EAED]"
                            : "bg-transparent hover:bg-[#F2F4F6]"
                        }`}
                      >
                        {/* Checkbox */}
                        <div
                          onClick={(e) => handleToggleSelect(sess.id, e)}
                          className="box-border w-[32px] shrink-0 h-[42px] flex flex-row gap-0 justify-center items-center cursor-pointer"
                        >
                          <div
                            className={`box-border w-[16px] shrink-0 h-[16px] flex flex-row gap-0 justify-center items-center rounded-[4px] ${
                              isChecked
                                ? "bg-[#12161C] [outline:1px_solid_#12161C]"
                                : "bg-[#FDFDFE] [outline:1px_solid_#81878D]"
                            } [outline-offset:-0.5px]`}
                          >
                            {isChecked && (
                              <svg
                                viewBox="0 0 14 14"
                                className="w-[12px] h-[12px]"
                                fill="#FDFDFE"
                              >
                                <path d="M5.6875 10.5q-0.16406 0-0.32813-0.10938l-3.0625-3.0625q-0.10938-0.16406-0.08203-0.32812 0.02734-0.16406 0.13672-0.27344 0.10938-0.10938 0.27344-0.13672 0.16406-0.02734 0.32812 0.08203l2.73438 2.78907 5.79688-5.85157q0.16406-0.10938 0.32812-0.08203 0.16406 0.02734 0.27344 0.13672 0.10937 0.10938 0.13672 0.27344 0.02734 0.16406-0.08203 0.32812l-6.125 6.125q-0.16406 0.10938-0.32813 0.10938z" />
                              </svg>
                            )}
                          </div>
                        </div>

                        {/* Text area */}
                        <div className="box-border [flex:1_1_0] h-fit flex flex-col gap-[4px] justify-start items-start overflow-hidden">
                          <div
                            className={`text-[14px]/[20px] box-border text-[#12161C] font-['Noto_Sans_SC',system-ui,sans-serif] ${
                              isActive ? "font-bold" : "font-normal"
                            } text-left truncate w-full`}
                          >
                            {sess.title}
                          </div>
                          <div className="box-border w-fit h-fit shrink-0 flex flex-row gap-[6px] justify-start items-center">
                            <div
                              className="box-border w-[20px] shrink-0 h-[20px] flex flex-row gap-0 justify-center items-center rounded-[4px]"
                              style={{ backgroundColor: badgeBg }}
                            >
                              <span className="text-[12px]/[17px] text-[#FDFDFE] font-[Overpass,system-ui,sans-serif] font-bold">
                                {markText}
                              </span>
                            </div>
                            <span className="text-[13px]/[18px] text-[#484E55] font-[Overpass,system-ui,sans-serif]">
                              Codex
                            </span>
                            <span className="text-[13px]/[18px] text-[#646970] font-['Overpass_Mono',system-ui,sans-serif] truncate max-w-[130px]">
                              D:\work\chimera-plusplus
                            </span>
                          </div>
                        </div>

                        {/* Tail */}
                        <div className="box-border w-fit shrink-0 h-fit flex flex-col gap-[4px] justify-start items-end">
                          <span className="text-[13px]/[18px] text-[#646970] font-[Overpass,system-ui,sans-serif]">
                            {sess.timeRange.split("–")[0]}
                          </span>
                          <span className="text-[13px]/[18px] text-[#646970] font-['Noto_Sans_SC',system-ui,sans-serif]">
                            {sess.rounds} 轮
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </React.Fragment>
              ))}
            </div>
          </div>

          {/* Right Column: Session Detail */}
          <div
            data-pencil-name="详情"
            className="box-border [flex:1_1_0] h-full flex flex-col gap-[12px] justify-start items-start overflow-y-auto pr-[8px]"
          >
            {/* Detail Header */}
            <div
              data-pencil-name="详情头"
              className="[box-sizing:content-box] w-full shrink-0 flex flex-col gap-[8px] p-[0px_0px_12px_0px] justify-start items-start [border-width:0px_0px_1px_0px] [border-style:solid] [border-color:#DDE0E3]"
            >
              <div className="text-[18px]/[23px] box-border w-full text-[#12161C] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold text-left">
                {activeSession.title}
              </div>

              <div className="box-border w-full h-fit shrink-0 flex flex-row gap-[8px] justify-start items-center">
                <div className="box-border w-[20px] shrink-0 h-[20px] flex flex-row gap-0 justify-center items-center bg-[#1A1E24] rounded-[999px]">
                  <span className="text-[12px]/[17px] text-[#FDFDFE] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold">
                    主
                  </span>
                </div>
                <span className="text-[13px]/[18px] text-[#484E55] font-[Overpass,system-ui,sans-serif]">
                  OpenAI 官方 · 主力 · Codex 0.61.0 ·
                </span>
                <span className="text-[13px]/[18px] text-[#484E55] font-['Overpass_Mono',system-ui,sans-serif]">
                  {activeSession.lineModel}
                </span>
              </div>

              <div className="text-[13px]/[18px] text-[#646970] font-['Noto_Sans_SC',system-ui,sans-serif]">
                {activeSession.rounds} 轮 · {activeSession.duration} · 词元{" "}
                {activeSession.tokensTotal} · 最后活动{" "}
                {activeSession.timeRange.split("–")[1] || "14:20"}
              </div>

              {/* Actions Bar */}
              <div className="box-border w-full h-fit shrink-0 flex flex-row gap-[8px] justify-start items-center pt-[4px]">
                {/* Resume Command Bar */}
                <div className="box-border [flex:1_1_0] h-[32px] flex flex-row gap-[6px] p-[0px_4px_0px_10px] justify-start items-center bg-[#F5F7F9] [outline:1px_solid_#DDE0E3] [outline-offset:-0.5px] rounded-[4px]">
                  <svg
                    viewBox="0 0 14 14"
                    className="w-[14px] h-[14px] shrink-0"
                    fill="#646970"
                  >
                    <path d="M7 7q0 0.21875-0.16406 0.32813l-2.1875 1.74999q-0.10938 0.10938-0.30078 0.10938-0.19141 0-0.30078-0.16406-0.10938-0.16406-0.10938-0.32813 0-0.16406 0.16406-0.27343l1.75-1.42188-1.75-1.42188q-0.21875-0.16406-0.1914-0.41015 0.02734-0.24609 0.27343-0.35547 0.24609-0.10938 0.46485 0.10938l2.1875 1.74999q0.16406 0.10938 0.16406 0.32813z m2.625 1.3125l-2.1875 0q-0.16406 0-0.30078 0.13672-0.13672 0.13672-0.13672 0.30078 0 0.16406 0.13672 0.30078 0.13672 0.13672 0.30078 0.13672l2.1875 0q0.16406 0 0.30078-0.13672 0.13672-0.13672 0.13672-0.30078 0-0.16406-0.13672-0.30078-0.13672-0.13672-0.30078-0.13672z" />
                  </svg>
                  <span className="text-[13px]/[18px] [flex:1_1_0] text-[#12161C] font-['Overpass_Mono',system-ui,sans-serif]">
                    {activeSession.resumeCmd}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyResume}
                    title={copied ? "已复制" : "复制恢复命令"}
                    className="box-border w-[28px] shrink-0 h-[28px] flex flex-row gap-0 justify-center items-center rounded-[4px] cursor-pointer hover:bg-[#DDE0E3] transition-colors"
                  >
                    {copied ? (
                      <span className="text-[12px] text-[#006AA0] font-bold">
                        ✓
                      </span>
                    ) : (
                      <svg
                        viewBox="0 0 14 14"
                        className="w-[14px] h-[14px]"
                        fill="#484E55"
                      >
                        <path d="M11.8125 1.75l-7 0q-0.16406 0-0.30078 0.13672-0.13672 0.13672-0.13672 0.30078l0 2.1875-2.1875 0q-0.16406 0-0.30078 0.13672-0.13672 0.13672-0.13672 0.30078l0 7q0 0.16406 0.13672 0.30078 0.13672 0.13672 0.30078 0.13672l7 0q0.16406 0 0.30078-0.13672 0.13672-0.13672 0.13672-0.30078l0-2.1875 2.1875 0q0.16406 0 0.30078-0.13672 0.13672-0.13672 0.13672-0.30078l0-7q0-0.16406-0.13672-0.30078-0.13672-0.13672-0.30078-0.13672z m-3.0625 9.625l-6.125 0 0-6.125 6.125 0 0 6.125z" />
                      </svg>
                    )}
                  </button>
                </div>

                <button
                  onClick={() =>
                    toast.success(`已导出「${activeSession.title}」`)
                  }
                  className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] p-[0px_12px] justify-center items-center bg-[#FDFDFE] [outline:1px_solid_#81878D] [outline-offset:-0.5px] rounded-[4px] cursor-pointer hover:bg-[#F2F4F6]"
                >
                  <svg
                    viewBox="0 0 14 14"
                    className="w-[16px] h-[16px]"
                    fill="#12161C"
                  >
                    <path d="M4.375 3.5q-0.10938-0.16406-0.10938-0.32813 0-0.16406 0.10938-0.32812l2.29688-2.29688q0.16406-0.10938 0.32812-0.10937 0.16406 0 0.32813 0.10937l2.29687 2.29688q0.10938 0.16406 0.10938 0.32813 0 0.16406-0.13672 0.30078-0.13672 0.13672-0.30078 0.13672-0.16406 0-0.32813-0.10938l-1.53125-1.58594 0 5.08594q0 0.16406-0.13672 0.30078-0.13672 0.13672-0.30078 0.13672-0.16406 0-0.30078-0.13672-0.13672-0.13672-0.13672-0.30078l0-5.08594-1.53125 1.58594q-0.16406 0.10938-0.32813 0.10938-0.16406 0-0.32812-0.10938z" />
                  </svg>
                  <span className="text-[14px]/[20px] text-[#12161C] font-['Noto_Sans_SC',system-ui,sans-serif]">
                    导出
                  </span>
                </button>

                <button
                  onClick={() =>
                    toast.info(`确定删除会话「${activeSession.title}」吗？`)
                  }
                  className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] p-[0px_12px] justify-center items-center rounded-[4px] cursor-pointer hover:bg-[#FBE8E8]"
                >
                  <svg
                    viewBox="0 0 14 14"
                    className="w-[16px] h-[16px]"
                    fill="#BE2323"
                  >
                    <path d="M11.8125 2.625l-2.1875 0 0-0.4375q0-0.54688-0.38281-0.92969-0.38281-0.38281-0.92969-0.38281l-2.625 0q-0.54688 0-0.92969 0.38281-0.38281 0.38281-0.38281 0.92969l0 0.4375-2.1875 0q-0.16406 0-0.30078 0.13672-0.13672 0.13672-0.13672 0.30078 0 0.16406 0.13672 0.30078 0.13672 0.13672 0.30078 0.13672l0.4375 0 0 7.875q0 0.38281 0.24609 0.62891 0.24609 0.24609 0.62891 0.24609l7 0q0.38281 0 0.62891-0.24609 0.24609-0.24609 0.24609-0.62891l0-7.875 0.4375 0q0.16406 0 0.30078-0.13672 0.13672-0.13672 0.13672-0.30078 0-0.16406-0.13672-0.30078-0.13672-0.13672-0.30078-0.13672z" />
                  </svg>
                  <span className="text-[14px]/[20px] text-[#BE2323] font-['Noto_Sans_SC',system-ui,sans-serif]">
                    删除
                  </span>
                </button>
              </div>
            </div>

            {/* Turn Round 1 */}
            <div
              data-pencil-name="第 1 轮"
              className="box-border w-full h-fit shrink-0 flex flex-col gap-[8px] p-[12px] justify-start items-start [outline:1px_solid_#DDE0E3] [outline-offset:-0.5px] rounded-[8px]"
            >
              <div className="box-border w-full h-fit shrink-0 flex flex-row gap-[8px] justify-start items-center">
                <span className="text-[13px]/[18px] text-[#484E55] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold">
                  第 1 轮
                </span>
                <span className="text-[13px]/[18px] text-[#646970] font-[Overpass,system-ui,sans-serif]">
                  13:08
                </span>
                <div className="flex-1" />
                <span className="text-[13px]/[18px] text-[#646970] font-['Noto_Sans_SC',system-ui,sans-serif]">
                  输入 2.6 万 · 输出 1180
                </span>
                <button className="box-border w-[28px] shrink-0 h-[28px] flex flex-row gap-0 justify-center items-center rounded-[4px] hover:bg-[#F2F4F6] cursor-pointer">
                  <svg
                    viewBox="0 0 14 14"
                    className="w-[18px] h-[18px]"
                    fill="#484E55"
                  >
                    <path d="M4.15625 7q0 0.27344-0.19141 0.46484-0.19141 0.19141-0.46484 0.19141-0.27344 0-0.46484-0.19141-0.19141-0.19141-0.19141-0.46484 0-0.27344 0.19141-0.46484 0.19141-0.19141 0.46484-0.19141 0.27344 0 0.46484 0.19141 0.19141 0.19141 0.19141 0.46484z m6.34375-0.65625q-0.27344 0-0.46484 0.19141-0.19141 0.19141-0.19141 0.46484 0 0.27344 0.19141 0.46484 0.19141 0.19141 0.46484 0.19141 0.27344 0 0.46484-0.19141 0.19141-0.19141 0.19141-0.46484 0-0.27344-0.19141-0.46484-0.19141-0.19141-0.46484-0.19141z m-3.5 0q-0.27344 0-0.46484 0.19141-0.19141 0.19141-0.19141 0.46484 0 0.27344 0.19141 0.46484 0.19141 0.19141 0.46484 0.19141 0.27344 0 0.46484-0.19141 0.19141-0.19141 0.19141-0.46484 0-0.27344-0.19141-0.46484-0.19141-0.19141-0.46484-0.19141z" />
                  </svg>
                </button>
              </div>

              <div className="text-[15px]/[26px] box-border w-full text-[#12161C] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal text-left">
                用户反馈升级后 config.toml 里的 profile
                整段不见了，先别改代码，找出是哪一步删掉的。
              </div>

              <div className="text-[15px]/[26px] box-border w-full text-[#484E55] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal text-left">
                读取了迁移流程的 4 个函数，问题出在清理废弃字段那一步：它把顶层
                profile 也当成废弃字段删除了。
              </div>

              <div className="box-border w-fit h-fit shrink-0 flex flex-row gap-[6px] justify-start items-center pt-[2px]">
                <div className="box-border w-fit shrink-0 h-[22px] flex flex-row gap-[4px] p-[0px_8px] justify-start items-center bg-[#ECEFF2] rounded-[4px]">
                  <svg
                    viewBox="0 0 14 14"
                    className="w-[12px] h-[12px]"
                    fill="#646970"
                  >
                    <path d="M11.70313 4.48438l-3.0625-3.0625q-0.16406-0.10938-0.32813-0.10938l-5.25 0q-0.38281 0-0.62891 0.24609-0.24609 0.24609-0.24609 0.62891l0 9.625q0 0.38281 0.24609 0.62891 0.24609 0.24609 0.62891 0.24609l7.875 0q0.38281 0 0.62891-0.24609 0.24609-0.24609 0.24609-0.62891l0-7q0-0.16406-0.10937-0.32813z" />
                  </svg>
                  <span className="text-[13px]/[18px] text-[#484E55] font-['Noto_Sans_SC',system-ui,sans-serif]">
                    读取 src-tauri/src/codex.rs
                  </span>
                </div>

                <div className="box-border w-fit shrink-0 h-[22px] flex flex-row gap-[4px] p-[0px_8px] justify-start items-center bg-[#ECEFF2] rounded-[4px]">
                  <svg
                    viewBox="0 0 14 14"
                    className="w-[12px] h-[12px]"
                    fill="#646970"
                  >
                    <path d="M7 7q0 0.21875-0.16406 0.32813l-2.1875 1.74999q-0.10938 0.10938-0.30078 0.10938-0.19141 0-0.30078-0.16406-0.10938-0.16406-0.10938-0.32813 0-0.16406 0.16406-0.27343l1.75-1.42188-1.75-1.42188q-0.21875-0.16406-0.1914-0.41015 0.02734-0.24609 0.27343-0.35547 0.24609-0.10938 0.46485 0.10938l2.1875 1.74999q0.16406 0.10938 0.16406 0.32813z" />
                  </svg>
                  <span className="text-[13px]/[18px] text-[#484E55] font-['Overpass_Mono',system-ui,sans-serif]">
                    cargo fmt --check
                  </span>
                </div>
              </div>
            </div>

            {/* Turn Round 12 */}
            <div
              data-pencil-name="第 12 轮"
              className="box-border w-full h-fit shrink-0 flex flex-col gap-[8px] p-[12px] justify-start items-start [outline:1px_solid_#DDE0E3] [outline-offset:-0.5px] rounded-[8px]"
            >
              <div className="box-border w-full h-fit shrink-0 flex flex-row gap-[8px] justify-start items-center">
                <span className="text-[13px]/[18px] text-[#484E55] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold">
                  第 12 轮
                </span>
                <span className="text-[13px]/[18px] text-[#646970] font-[Overpass,system-ui,sans-serif]">
                  13:41
                </span>
                <div className="flex-1" />
                <span className="text-[13px]/[18px] text-[#646970] font-['Noto_Sans_SC',system-ui,sans-serif]">
                  输入 4.1 万 · 输出 2450
                </span>
                <button className="box-border w-[28px] shrink-0 h-[28px] flex flex-row gap-0 justify-center items-center rounded-[4px] hover:bg-[#F2F4F6] cursor-pointer">
                  <svg
                    viewBox="0 0 14 14"
                    className="w-[18px] h-[18px]"
                    fill="#484E55"
                  >
                    <path d="M4.15625 7q0 0.27344-0.19141 0.46484-0.19141 0.19141-0.46484 0.19141-0.27344 0-0.46484-0.19141-0.19141-0.19141-0.19141-0.46484 0-0.27344 0.19141-0.46484 0.19141-0.19141 0.46484-0.19141 0.27344 0 0.46484 0.19141 0.19141 0.19141 0.19141 0.46484z" />
                  </svg>
                </button>
              </div>

              <div className="text-[15px]/[26px] box-border w-full text-[#12161C] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal text-left">
                给出只保留白名单字段同时不误伤顶层 table 的最小补丁。
              </div>

              <div className="text-[15px]/[26px] box-border w-full text-[#484E55] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal text-left">
                已验证单测，使用 toml_edit 的 entry API 进行就地保留。
              </div>

              <div className="box-border w-fit h-fit shrink-0 flex flex-row gap-[6px] justify-start items-center pt-[2px]">
                <div className="box-border w-fit shrink-0 h-[22px] flex flex-row gap-[4px] p-[0px_8px] justify-start items-center bg-[#ECEFF2] rounded-[4px]">
                  <svg
                    viewBox="0 0 14 14"
                    className="w-[12px] h-[12px]"
                    fill="#646970"
                  >
                    <path d="M11.70313 4.48438l-3.0625-3.0625q-0.16406-0.10938-0.32813-0.10938l-5.25 0q-0.38281 0-0.62891 0.24609-0.24609 0.24609-0.24609 0.62891l0 9.625q0 0.38281 0.24609 0.62891 0.24609 0.24609 0.62891 0.24609l7.875 0q0.38281 0 0.62891-0.24609 0.24609-0.24609 0.24609-0.62891l0-7q0-0.16406-0.10937-0.32813z" />
                  </svg>
                  <span className="text-[13px]/[18px] text-[#484E55] font-['Noto_Sans_SC',system-ui,sans-serif]">
                    编辑 src-tauri/src/codex.rs
                  </span>
                </div>
                <div className="box-border w-fit shrink-0 h-[22px] flex flex-row gap-[4px] p-[0px_8px] justify-start items-center bg-[#ECEFF2] rounded-[4px]">
                  <svg
                    viewBox="0 0 14 14"
                    className="w-[12px] h-[12px]"
                    fill="#646970"
                  >
                    <path d="M7 7q0 0.21875-0.16406 0.32813l-2.1875 1.74999q-0.10938 0.10938-0.30078 0.10938-0.19141 0-0.30078-0.16406-0.10938-0.16406-0.10938-0.32813 0-0.16406 0.16406-0.27343l1.75-1.42188-1.75-1.42188q-0.21875-0.16406-0.1914-0.41015 0.02734-0.24609 0.27343-0.35547 0.24609-0.10938 0.46485 0.10938l2.1875 1.74999q0.16406 0.10938 0.16406 0.32813z" />
                  </svg>
                  <span className="text-[13px]/[18px] text-[#484E55] font-['Overpass_Mono',system-ui,sans-serif]">
                    cargo test config_migration
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
