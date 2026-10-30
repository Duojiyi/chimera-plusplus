import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Gauge,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  type LucideIcon,
} from "lucide-react";
import type { Provider } from "@/types";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { isOfficialLine } from "@/utils/lineBadge";
import {
  extractCodexBaseUrl,
  extractCodexModelName,
} from "@/utils/providerConfigUtils";
import { LineBadge } from "@/components/LineBadge";
import "./CommandPalette.css";

export interface PalettePage {
  id: string;
  label: string;
  icon: LucideIcon;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  providers: Provider[];
  currentProviderId: string | null;
  /** The name each line has in the line list. */
  lineName?: (provider: Provider) => string;
  /** Pages the user can open, in navigation order. */
  pages: PalettePage[];
  onSwitchProvider: (id: string) => void;
  onNavigate: (view: string) => void;
  onAddProvider: () => void;
  onSpeedTestAll?: () => void;
  onEditProvider?: (id: string) => void;
  onRefresh?: () => void;
}

interface PaletteItem {
  id: string;
  group: "线路" | "页面" | "命令";
  title: string;
  subtitle?: string;
  keywords?: string;
  line?: Provider;
  icon?: LucideIcon;
  current?: boolean;
  /** Edit entries appear once the user types, so the first view stays short. */
  searchOnly?: boolean;
  onSelect: () => void;
  onAltSelect?: () => void;
}

function lineSubtitle(provider: Provider): string {
  const config = String(provider.settingsConfig?.config ?? "");
  const host = extractCodexBaseUrl(config)
    ?.replace(/^https?:\/\//, "")
    .split("/")[0];
  const model = extractCodexModelName(config);
  if (isOfficialLine(provider))
    return model ? `ChatGPT 登录 · ${model}` : "ChatGPT 登录";
  return [host, model].filter(Boolean).join(" · ") || "已保存的线路";
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  providers,
  currentProviderId,
  lineName = (provider) => provider.name,
  pages,
  onSwitchProvider,
  onNavigate,
  onAddProvider,
  onSpeedTestAll,
  onEditProvider,
  onRefresh,
}) => {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose, isOpen);
  const idPrefix = useId();

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
    }
  }, [isOpen]);

  const items = useMemo<PaletteItem[]>(() => {
    const run = (action: () => void) => () => {
      action();
      onClose();
    };
    const list: PaletteItem[] = [];
    // Only lines supplied by the backend; nothing is invented for an empty store.
    for (const provider of providers) {
      const name = lineName(provider);
      const editable = Boolean(onEditProvider) && !isOfficialLine(provider);
      const edit = editable
        ? run(() => onEditProvider?.(provider.id))
        : undefined;
      list.push({
        id: `switch-line-${provider.id}`,
        group: "线路",
        title: `切换到 ${name}`,
        subtitle: lineSubtitle(provider),
        keywords: provider.name,
        line: provider,
        current: provider.id === currentProviderId,
        onSelect: run(() => onSwitchProvider(provider.id)),
        onAltSelect: edit,
      });
      if (edit) {
        list.push({
          id: `edit-line-${provider.id}`,
          group: "线路",
          title: `编辑 ${name}`,
          subtitle: "打开线路编辑",
          keywords: provider.name,
          icon: Pencil,
          searchOnly: true,
          onSelect: edit,
        });
      }
    }
    for (const page of pages) {
      list.push({
        id: `page-${page.id}`,
        group: "页面",
        title: page.label,
        icon: page.icon,
        onSelect: run(() => onNavigate(page.id)),
      });
    }
    if (onSpeedTestAll) {
      list.push({
        id: "action-speedtest-all",
        group: "命令",
        title: "测速全部线路",
        subtitle: "检查每个请求地址能否连通",
        icon: Gauge,
        onSelect: run(onSpeedTestAll),
      });
    }
    list.push({
      id: "action-add-provider",
      group: "命令",
      title: "添加线路",
      subtitle: "填写请求地址、密钥和模型",
      icon: Plus,
      onSelect: run(onAddProvider),
    });
    if (onRefresh) {
      list.push({
        id: "action-refresh",
        group: "命令",
        title: "重新读取线路",
        subtitle: "从本机重新读取线路和当前状态",
        icon: RefreshCw,
        onSelect: run(onRefresh),
      });
    }
    return list;
  }, [
    providers,
    currentProviderId,
    lineName,
    pages,
    onSwitchProvider,
    onNavigate,
    onAddProvider,
    onSpeedTestAll,
    onRefresh,
    onEditProvider,
    onClose,
  ]);

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.filter((item) => !item.searchOnly);
    return items.filter((item) =>
      [item.title, item.subtitle, item.keywords, item.group]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [items, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (selectedIndex >= filteredItems.length) {
      setSelectedIndex(Math.max(0, filteredItems.length - 1));
    }
  }, [filteredItems.length, selectedIndex]);

  useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // Escape and focus return are handled by useDialogFocus.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!filteredItems.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setSelectedIndex(
        (prev) => (prev + step + filteredItems.length) % filteredItems.length,
      );
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const current = filteredItems[selectedIndex];
      if (!current) return;
      if ((e.ctrlKey || e.metaKey) && current.onAltSelect) {
        current.onAltSelect();
      } else {
        current.onSelect();
      }
    }
  };

  if (!isOpen) return null;

  const listId = `${idPrefix}-list`;
  const optionId = (index: number) => `${idPrefix}-option-${index}`;
  const groups: { name: PaletteItem["group"]; entries: number[] }[] = [];
  filteredItems.forEach((item, index) => {
    const last = groups[groups.length - 1];
    if (last && last.name === item.group) last.entries.push(index);
    else groups.push({ name: item.group, entries: [index] });
  });

  return (
    <div
      className="command-palette-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        tabIndex={-1}
      >
        <div className="command-palette-search">
          <Search size={18} aria-hidden="true" />
          <input
            data-autofocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索线路、页面或命令"
            aria-label="搜索线路、页面或命令"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              filteredItems.length ? optionId(selectedIndex) : undefined
            }
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="command-palette-keycap is-button"
            onClick={onClose}
            aria-label="关闭命令面板"
          >
            Esc
          </button>
        </div>

        <div className="command-palette-list" id={listId} role="listbox">
          {filteredItems.length === 0 ? (
            <p className="command-palette-empty" role="presentation">
              没有找到“{query.trim()}”相关的线路、页面或命令
            </p>
          ) : (
            groups.map((group) => (
              <div
                key={group.name}
                role="group"
                aria-labelledby={`${idPrefix}-${group.name}`}
              >
                <div
                  className="command-palette-group"
                  id={`${idPrefix}-${group.name}`}
                  role="presentation"
                >
                  {group.name}
                </div>
                {group.entries.map((index) => {
                  const item = filteredItems[index];
                  const selected = index === selectedIndex;
                  const Icon = item.icon;
                  return (
                    <div
                      key={item.id}
                      id={optionId(index)}
                      ref={(el) => {
                        itemRefs.current[index] = el;
                      }}
                      role="option"
                      aria-selected={selected}
                      className="command-palette-item"
                      onClick={() => item.onSelect()}
                      onMouseMove={() => {
                        if (!selected) setSelectedIndex(index);
                      }}
                    >
                      {/* One fixed slot for badges and icons, so a two-character
                          badge (自建, 智谱) does not push its title right. */}
                      <span className="command-palette-icon">
                        {item.line ? (
                          <LineBadge line={item.line} size="sm" />
                        ) : (
                          Icon && <Icon size={16} aria-hidden="true" />
                        )}
                      </span>
                      <span className="command-palette-text">
                        <span className="command-palette-title">
                          {item.title}
                        </span>
                        {item.subtitle && (
                          <span className="command-palette-subtitle">
                            {item.subtitle}
                          </span>
                        )}
                      </span>
                      {item.current && (
                        <span className="command-palette-current">
                          当前线路
                        </span>
                      )}
                      {selected && (
                        <span
                          className="command-palette-keycap"
                          aria-hidden="true"
                        >
                          Enter
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="command-palette-footer" aria-hidden="true">
          <span>
            <kbd className="command-palette-keycap">↑ ↓</kbd>选择
          </span>
          <span>
            <kbd className="command-palette-keycap">Enter</kbd>执行
          </span>
          {onEditProvider && (
            <span>
              <kbd className="command-palette-keycap">Ctrl Enter</kbd>
              编辑线路
            </span>
          )}
          <span>
            <kbd className="command-palette-keycap">Esc</kbd>关闭
          </span>
        </div>
      </div>
    </div>
  );
};
