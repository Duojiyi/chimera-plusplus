import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Provider } from "@/types";

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  providers: Provider[];
  currentProviderId: string | null;
  onSwitchProvider: (id: string) => void;
  onNavigate: (view: string) => void;
  onAddProvider: () => void;
  onSpeedTestAll?: () => void;
  onCheckHealth?: () => void;
  onOpenCodex?: () => void;
  onEditProvider?: (id: string) => void;
  onRefresh?: () => void;
  canNavigate: (view: string) => boolean;
}

interface PaletteItem {
  id: string;
  group: "线路" | "会话" | "页面" | "命令";
  title: string;
  subtitle?: string;
  badge?: {
    text: string;
    bgColor: string;
    isCircle?: boolean;
  };
  iconType?: "pencil" | "gauge" | "chat" | "chart" | "plus" | "shield" | "gear";
  latency?: {
    text: string;
    grade: string;
  };
  keycap?: string;
  onSelect: () => void;
  onCtrlSelect?: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  providers,
  currentProviderId,
  onSwitchProvider,
  onNavigate,
  canNavigate,
  onAddProvider,
  onSpeedTestAll,
  onCheckHealth,
  onEditProvider,
  onRefresh,
}) => {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [isOpen]);

  // Construct items
  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = [];

    // Only offer provider IDs supplied by the backend.
    for (const provider of providers) {
      list.push({
        id: `switch-line-${provider.id}`,
        group: "线路",
        title: `切换到 ${provider.name}`,
        subtitle:
          provider.id === currentProviderId ? "当前线路" : "切换已保存的线路",
        keycap: "Enter",
        onSelect: () => {
          onSwitchProvider(provider.id);
          onClose();
        },
        onCtrlSelect: onEditProvider
          ? () => {
              onEditProvider(provider.id);
              onClose();
            }
          : undefined,
      });
      if (onEditProvider) {
        list.push({
          id: `edit-line-${provider.id}`,
          group: "线路",
          title: `编辑 ${provider.name}`,
          subtitle: "打开线路编辑",
          iconType: "pencil",
          onSelect: () => {
            onEditProvider(provider.id);
            onClose();
          },
        });
      }
    }
    list.push(
      {
        id: "page-sessions",
        group: "页面",
        title: "查看会话",
        subtitle: "打开本地会话管理",
        iconType: "chat",
        onSelect: () => {
          onNavigate("sessions");
          onClose();
        },
      },
      {
        id: "page-usage",
        group: "页面",
        title: "查看用量",
        subtitle: "打开实际用量统计",
        iconType: "chart",
        onSelect: () => {
          onNavigate("usage");
          onClose();
        },
      },
    );
    if (onSpeedTestAll) {
      list.push({
        id: "action-speedtest-all",
        group: "命令",
        title: "测速全部线路",
        iconType: "gauge",
        onSelect: () => {
          onSpeedTestAll();
          onClose();
        },
      });
    }

    if (canNavigate("health"))
      list.push({
        id: "page-health",
        group: "页面",
        title: "配置体检",
        subtitle: "同名 profile、端口占用与权限诊断",
        iconType: "shield",
        onSelect: () => {
          onNavigate("health");
          onClose();
        },
      });

    if (canNavigate("official-accounts"))
      list.push({
        id: "page-official",
        group: "页面",
        title: "官方账号管理",
        subtitle: "ChatGPT Web 登录与设备码接入",
        iconType: "gear",
        onSelect: () => {
          onNavigate("official-accounts");
          onClose();
        },
      });

    list.push({
      id: "action-add-provider",
      group: "命令",
      title: "添加新线路",
      subtitle: "配置自定义中转或兼容 OpenAI / Anthropic 端点",
      iconType: "plus",
      onSelect: () => {
        onAddProvider();
        onClose();
      },
    });

    if (onCheckHealth && canNavigate("health")) {
      list.push({
        id: "action-check-health",
        group: "命令",
        title: "打开配置体检",
        subtitle: "扫描 config.toml、auth.json 与端口占用",
        iconType: "shield",
        onSelect: () => {
          onCheckHealth();
          onClose();
        },
      });
    }

    if (onRefresh) {
      list.push({
        id: "action-refresh",
        group: "命令",
        title: "重新加载配置与状态",
        subtitle: "重新读取当前线路配置",
        iconType: "gauge",
        onSelect: () => {
          onRefresh();
          onClose();
        },
      });
    }

    return list;
  }, [
    providers,
    currentProviderId,
    onSwitchProvider,
    onNavigate,
    canNavigate,
    onAddProvider,
    onSpeedTestAll,
    onCheckHealth,
    onRefresh,
    onEditProvider,
    onClose,
  ]);

  // Filter items
  const filteredItems = useMemo(() => {
    if (!query.trim()) return items.slice(0, 16);
    const q = query.toLowerCase().trim();
    return items.filter(
      (it) =>
        it.title.toLowerCase().includes(q) ||
        (it.subtitle && it.subtitle.toLowerCase().includes(q)) ||
        it.group.toLowerCase().includes(q),
    );
  }, [items, query]);

  // Reset selectedIndex if out of bounds
  useEffect(() => {
    if (selectedIndex >= filteredItems.length) {
      setSelectedIndex(Math.max(0, filteredItems.length - 1));
    }
  }, [filteredItems.length, selectedIndex]);

  // Scroll active item into view
  useEffect(() => {
    const el = itemRefs.current[selectedIndex];
    if (el) {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  // Keyboard handler
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        prev < filteredItems.length - 1 ? prev + 1 : 0,
      );
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        prev > 0 ? prev - 1 : filteredItems.length - 1,
      );
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      const current = filteredItems[selectedIndex];
      if (!current) return;
      if (e.ctrlKey || e.metaKey) {
        if (current.onCtrlSelect) {
          current.onCtrlSelect();
        } else {
          current.onSelect();
        }
      } else {
        current.onSelect();
      }
    }
  };

  if (!isOpen) return null;

  // Group items by group header
  let lastGroup = "";

  return (
    <div
      className="box-border w-full h-full fixed inset-0 flex flex-col p-[64px_0px_0px_0px] justify-start items-center bg-[#12161C66] z-[9999]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="box-border w-[640px] h-fit shrink-0 [box-shadow:0px_16px_40px_#12161C1F,_0px_2px_6px_#12161C0F] flex flex-col gap-0 justify-start items-start bg-[#FDFDFE] [outline:1px_solid_#00000000] [outline-offset:-0.5px] rounded-[8px] overflow-hidden">
        {/* Input Bar */}
        <div className="[box-sizing:content-box] w-[640px] h-[51.5px] shrink-0 flex flex-row gap-[12px] p-[0px_16px] justify-start items-center [border-width:0px_0px_1px_0px] [border-style:solid] [border-color:#DDE0E3] [margin:0px_0px_-0.5px_0px]">
          <svg
            viewBox="0 0 14 14"
            className="w-[18px] h-[18px] shrink-0"
            fill="#484E55"
          >
            <path d="M12.57813 11.92188l-2.40625-2.35157q0.875-1.03906 1.12109-2.29687 0.24609-1.25781-0.16406-2.51563-0.41016-1.25781-1.39453-2.16015-0.98438-0.90234-2.24219-1.17578-1.25781-0.27344-2.51563 0.05468-1.25781 0.32813-2.21484 1.28516-0.95703 0.95703-1.28516 2.21484-0.32813 1.25781-0.05468 2.51563 0.27344 1.25781 1.17578 2.24219 0.90234 0.98438 2.16015 1.39453 1.25781 0.41016 2.51563 0.16406 1.25781-0.24609 2.29687-1.12109l2.35157 2.40625q0.16406 0.10938 0.32812 0.10937 0.16406 0 0.30078-0.13672 0.13672-0.13672 0.13672-0.30078 0-0.16406-0.10937-0.32812z m-10.39063-5.57813q0-1.14844 0.54688-2.10547 0.54688-0.95703 1.5039-1.50391 0.95703-0.54688 2.10547-0.54687 1.14844 0 2.10547 0.54688 0.95703 0.54688 1.50391 1.5039 0.54688 0.95703 0.54687 2.10547 0 1.14844-0.54688 2.10547-0.54688 0.95703-1.5039 1.50391-0.95703 0.54688-2.10547 0.54687-1.14844 0-2.10547-0.54688-0.95703-0.54688-1.50391-1.5039-0.54688-0.95703-0.54687-2.10547z" />
          </svg>
          <div className="flex-1 flex items-center">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="搜索线路、页面或命令"
              className="text-[18px]/[23px] w-full text-[#12161C] font-[Overpass,system-ui,sans-serif] bg-transparent outline-none border-none placeholder-[#646970]"
            />
          </div>
          <button
            onClick={onClose}
            className="box-border w-fit shrink-0 h-[20px] flex flex-row gap-0 p-[0px_6px] justify-start items-center bg-[#FDFDFE] [outline:1px_solid_#DDE0E3] [outline-offset:-0.5px] rounded-[4px] cursor-pointer hover:bg-[#F2F4F6]"
          >
            <span className="text-[12px]/[17px] text-[#646970] font-[Overpass,system-ui,sans-serif]">
              Esc
            </span>
          </button>
        </div>

        {/* Results List */}
        <div className="box-border w-full h-fit max-h-[460px] overflow-y-auto shrink-0 flex flex-col gap-[2px] p-[8px] justify-start items-start">
          {filteredItems.length === 0 ? (
            <div className="w-full py-[32px] text-center text-[14px] text-[#646970] font-['Noto_Sans_SC',system-ui,sans-serif]">
              未找到匹配项
            </div>
          ) : (
            filteredItems.map((item, idx) => {
              const showGroupHeader = item.group !== lastGroup;
              if (showGroupHeader) lastGroup = item.group;
              const isSelected = idx === selectedIndex;

              return (
                <React.Fragment key={item.id}>
                  {showGroupHeader && (
                    <div className="text-[13px]/[18px] text-[#646970] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold px-[12px] pt-[8px] pb-[3px] select-none">
                      {item.group}
                    </div>
                  )}
                  <div
                    ref={(el) => {
                      itemRefs.current[idx] = el;
                    }}
                    onClick={() => item.onSelect()}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`box-border w-full h-[40px] shrink-0 flex flex-row gap-[12px] p-[0px_12px] justify-start items-center rounded-[4px] relative cursor-pointer ${
                      isSelected
                        ? "bg-[#E7EAED]"
                        : "bg-transparent hover:bg-[#F2F4F6]"
                    }`}
                  >
                    {/* Blue selection indicator bar */}
                    {isSelected && (
                      <div className="box-border w-[3px] h-[20px] absolute left-0 top-[10px] bg-[#006AA0] rounded-[2px] z-10" />
                    )}

                    {/* Badge or Icon */}
                    {item.badge ? (
                      <div
                        className={`box-border w-[20px] shrink-0 h-[20px] flex flex-row gap-0 justify-center items-center ${
                          item.badge.isCircle
                            ? "rounded-[999px]"
                            : "rounded-[4px]"
                        }`}
                        style={{ backgroundColor: item.badge.bgColor }}
                      >
                        <span className="text-[12px]/[17px] text-[#FDFDFE] font-[Overpass,system-ui,sans-serif] font-bold">
                          {item.badge.text}
                        </span>
                      </div>
                    ) : (
                      <span className="w-[18px] h-[18px] flex items-center justify-center shrink-0">
                        {item.iconType === "pencil" && (
                          <svg
                            viewBox="0 0 14 14"
                            className="w-[16px] h-[16px]"
                            fill="#484E55"
                          >
                            <path d="M12.25 4.21094l-2.46094-2.46094q-0.21875-0.27344-0.60156-0.27344-0.38281 0-0.60156 0.27344l-6.5625 6.5625q-0.27344 0.27344-0.27344 0.60156l0 2.46094q0 0.38281 0.24609 0.62891 0.24609 0.24609 0.62891 0.24609l2.46094 0q0.32813 0 0.60156-0.27344l6.5625-6.5625q0.27344-0.21875 0.27344-0.60156 0-0.38281-0.27344-0.60156z m-7.16406 7.16406l-2.46094 0 0-2.46094 4.8125-4.8125 2.46094 2.46094-4.8125 4.8125z m5.41406-5.41406l-2.46094-2.46094 1.14844-1.14844 2.46094 2.46094-1.14844 1.14844z" />
                          </svg>
                        )}
                        {item.iconType === "gauge" && (
                          <svg
                            viewBox="0 0 14 14"
                            className="w-[16px] h-[16px]"
                            fill="#484E55"
                          >
                            <path d="M11.32031 4.42969q-0.875-0.875-1.99609-1.33985-1.12109-0.46484-2.32422-0.46484-1.36719 0-2.57031 0.57422-1.20313 0.57422-2.07813 1.58594-0.875 1.01172-1.20312 2.26953l-0.05469 0.21875q-0.21875 0.76563-0.21875 1.53125l0 1.25781q0 0.38281 0.24609 0.62891 0.24609 0.24609 0.62891 0.24609l10.5 0q0.38281 0 0.62891-0.24609 0.24609-0.24609 0.24609-0.62891l0-1.3125q0-1.20313-0.46484-2.35156-0.46484-1.14844-1.33985-1.96875z" />
                          </svg>
                        )}
                        {item.iconType === "chat" && (
                          <svg
                            viewBox="0 0 14 14"
                            className="w-[16px] h-[16px]"
                            fill="#484E55"
                          >
                            <path d="M7 1.3125q-1.53125 0-2.81641 0.73828-1.28516 0.73828-2.07812 2.05078-0.79297 1.3125-0.79297 2.81641 0 1.50391 0.71094 2.81641l-0.49219 1.64062q-0.05469 0.21875 0 0.46484 0.05469 0.24609 0.21875 0.41016 0.16406 0.16406 0.41016 0.21875 0.24609 0.05469 0.46484 0l1.64063-0.49219q1.58594 0.875 3.33593 0.6836 1.75-0.19141 3.11719-1.36719 1.36719-1.17578 1.80469-2.89844 0.4375-1.72266-0.19141-3.39062-0.62891-1.66797-2.07812-2.67969-1.44922-1.01172-3.25391-1.01172z" />
                          </svg>
                        )}
                        {item.iconType === "chart" && (
                          <svg
                            viewBox="0 0 14 14"
                            className="w-[16px] h-[16px]"
                            fill="#484E55"
                          >
                            <path d="M12.46875 10.9375l-0.4375 0 0-8.75q0-0.16406-0.13672-0.30078-0.13672-0.13672-0.30078-0.13672l-3.0625 0q-0.16406 0-0.30078 0.13672-0.13672 0.13672-0.13672 0.30078l0 2.1875-2.625 0q-0.16406 0-0.30078 0.13672-0.13672 0.13672-0.13672 0.30078l0 2.1875-2.625 0q-0.16406 0-0.30078 0.13672-0.13672 0.13672-0.13672 0.30078l0 3.5-0.4375 0" />
                          </svg>
                        )}
                        {(!item.iconType ||
                          item.iconType === "gear" ||
                          item.iconType === "shield" ||
                          item.iconType === "plus") && (
                          <svg
                            viewBox="0 0 14 14"
                            className="w-[16px] h-[16px]"
                            fill="#484E55"
                          >
                            <path d="M12.25 7q0 0.16406-0.13672 0.30078-0.13672 0.13672-0.30078 0.13672l-4.375 0 0 4.375q0 0.16406-0.13672 0.30078-0.13672 0.13672-0.30078 0.13672-0.16406 0-0.30078-0.13672-0.13672-0.13672-0.13672-0.30078l0-4.375-4.375 0q-0.16406 0-0.30078-0.13672-0.13672-0.13672-0.13672-0.30078 0-0.16406 0.13672-0.30078 0.13672-0.13672 0.30078-0.13672l4.375 0 0-4.375q0-0.16406 0.13672-0.30078 0.13672-0.13672 0.30078-0.13672 0.16406 0 0.30078 0.13672 0.13672 0.13672 0.13672 0.30078l0 4.375 4.375 0q0.16406 0 0.30078 0.13672 0.13672 0.13672 0.13672 0.30078z" />
                          </svg>
                        )}
                      </span>
                    )}

                    {/* Text Title & Subtitle */}
                    <div className="flex-1 min-w-0 flex items-center gap-[8px]">
                      <span
                        className={`text-[14px]/[20px] text-[#12161C] font-['Noto_Sans_SC',system-ui,sans-serif] ${isSelected ? "font-bold" : "font-normal"} whitespace-nowrap`}
                      >
                        {item.title}
                      </span>
                      {item.subtitle && (
                        <span className="text-[13px]/[18px] text-[#646970] font-['Noto_Sans_SC',system-ui,sans-serif] truncate">
                          {item.subtitle}
                        </span>
                      )}
                    </div>

                    {/* Latency info */}
                    {item.latency && (
                      <div className="box-border w-fit shrink-0 h-[20px] flex flex-row gap-[6px] justify-start items-center">
                        <span className="text-[13px]/[18px] text-[#12161C] font-[Overpass,system-ui,sans-serif] font-normal whitespace-nowrap">
                          {item.latency.text}
                        </span>
                        <span className="text-[13px]/[18px] text-[#646970] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold whitespace-nowrap">
                          {item.latency.grade}
                        </span>
                      </div>
                    )}

                    {/* Keycap */}
                    {item.keycap && (
                      <div className="box-border w-fit shrink-0 h-[20px] flex flex-row gap-0 p-[0px_6px] justify-start items-center bg-[#FDFDFE] [outline:1px_solid_#DDE0E3] [outline-offset:-0.5px] rounded-[4px]">
                        <span className="text-[12px]/[17px] text-[#646970] font-[Overpass,system-ui,sans-serif] font-normal whitespace-nowrap">
                          {item.keycap}
                        </span>
                      </div>
                    )}
                  </div>
                </React.Fragment>
              );
            })
          )}
        </div>

        {/* Footer with key instructions */}
        <div className="[box-sizing:content-box] w-[640px] h-[39.5px] shrink-0 flex flex-row gap-[16px] p-[0px_16px] justify-start items-center bg-[#F2F4F6] [border-width:1px_0px_0px_0px] [border-style:solid] [border-color:#DDE0E3] [margin:-0.5px_0px_0px_0px]">
          <div className="flex items-center gap-[6px]">
            <div className="box-border w-fit shrink-0 h-[20px] flex flex-row gap-0 p-[0px_6px] justify-start items-center bg-[#FDFDFE] [outline:1px_solid_#DDE0E3] [outline-offset:-0.5px] rounded-[4px]">
              <span className="text-[12px]/[17px] text-[#646970] font-[Overpass,system-ui,sans-serif] font-normal whitespace-nowrap">
                ↑ ↓
              </span>
            </div>
            <span className="text-[13px]/[18px] text-[#646970] font-['Noto_Sans_SC',system-ui,sans-serif]">
              选择
            </span>
          </div>

          <div className="flex items-center gap-[6px]">
            <div className="box-border w-fit shrink-0 h-[20px] flex flex-row gap-0 p-[0px_6px] justify-start items-center bg-[#FDFDFE] [outline:1px_solid_#DDE0E3] [outline-offset:-0.5px] rounded-[4px]">
              <span className="text-[12px]/[17px] text-[#646970] font-[Overpass,system-ui,sans-serif] font-normal whitespace-nowrap">
                Enter
              </span>
            </div>
            <span className="text-[13px]/[18px] text-[#646970] font-['Noto_Sans_SC',system-ui,sans-serif]">
              执行
            </span>
          </div>

          <div className="flex items-center gap-[6px]">
            <div className="box-border w-fit shrink-0 h-[20px] flex flex-row gap-0 p-[0px_6px] justify-start items-center bg-[#FDFDFE] [outline:1px_solid_#DDE0E3] [outline-offset:-0.5px] rounded-[4px]">
              <span className="text-[12px]/[17px] text-[#646970] font-[Overpass,system-ui,sans-serif] font-normal whitespace-nowrap">
                Ctrl Enter
              </span>
            </div>
            <span className="text-[13px]/[18px] text-[#646970] font-['Noto_Sans_SC',system-ui,sans-serif]">
              编辑
            </span>
          </div>

          <div className="flex items-center gap-[6px]">
            <div className="box-border w-fit shrink-0 h-[20px] flex flex-row gap-0 p-[0px_6px] justify-start items-center bg-[#FDFDFE] [outline:1px_solid_#DDE0E3] [outline-offset:-0.5px] rounded-[4px]">
              <span className="text-[12px]/[17px] text-[#646970] font-[Overpass,system-ui,sans-serif] font-normal whitespace-nowrap">
                Esc
              </span>
            </div>
            <span className="text-[13px]/[18px] text-[#646970] font-['Noto_Sans_SC',system-ui,sans-serif]">
              关闭
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
