import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Check, Search, X } from "lucide-react";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import {
  PRESET_FILTERS,
  PRESET_GROUP_LABELS,
  blankSelection,
  countByFilter,
  endpointPlaceholder,
  filterPresets,
  selectPreset,
  startablePresets,
  type PresetEntry,
  type PresetFilter,
  type PresetSelection,
} from "@/utils/codexPresetDraft";
import "./CodexPresetPicker.css";

// The muted line palette the rest of the app uses for badges; a preset's own
// brand colour would clash with it.
const BADGE_COLORS = [
  "#537197",
  "#776894",
  "#8F607A",
  "#357B7F",
  "#61774B",
  "#8F6446",
] as const;

function badgeColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return BADGE_COLORS[hash % BADGE_COLORS.length];
}

function markOf(name: string): string {
  return (Array.from(name.trim())[0] ?? "?").toUpperCase();
}

export interface CodexPresetPickerProps {
  /** Name of the starting point the draft currently came from, if any. */
  current: string | null;
  /** The draft has edits that applying a preset would replace. */
  dirty: boolean;
  onPick: (selection: PresetSelection) => void;
  onClose: () => void;
}

/** Modal list of vendor presets for a new Codex line, with search and groups. */
export default function CodexPresetPicker({
  current,
  dirty,
  onPick,
  onClose,
}: CodexPresetPickerProps) {
  const titleId = useId();
  const dialogRef = useDialogFocus<HTMLElement>(onClose);
  const entries = useMemo(() => startablePresets(), []);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PresetFilter>("all");
  const results = useMemo(
    () => filterPresets(entries, query, filter),
    [entries, query, filter],
  );
  const counts = useMemo(() => countByFilter(entries, query), [entries, query]);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [query, filter]);

  const pick = (entry: PresetEntry) => onPick(selectPreset(entry.preset));

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter commits an IME composition (pinyin) and must not also pick.
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      listRef.current?.querySelector<HTMLElement>(".preset-row")?.focus();
    } else if (event.key === "Enter" && results[0]) {
      event.preventDefault();
      pick(results[0]);
    }
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(".preset-row"),
    );
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at === -1) return;
    event.preventDefault();
    if (event.key === "ArrowDown")
      rows[Math.min(at + 1, rows.length - 1)].focus();
    else if (at === 0) searchRef.current?.focus();
    else rows[at - 1].focus();
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        ref={dialogRef}
        className="preset-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="preset-picker-head">
          <div>
            <h2 id={titleId}>选择预设</h2>
            <p>
              选一个供应商，自动填好地址、模型和协议；API Key 仍由你自己填写。
            </p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭预设列表"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        {dirty && (
          <p className="preset-picker-notice" role="note">
            当前线路已有修改，套用预设会重置地址、密钥、模型映射和高级设置。
          </p>
        )}
        <div className="preset-picker-tools">
          <label className="preset-search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchRef}
              data-autofocus
              type="search"
              value={query}
              placeholder="搜索名称、地址或模型"
              aria-label="搜索预设"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
            />
          </label>
          <div className="preset-filters" role="group" aria-label="预设分类">
            {PRESET_FILTERS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                aria-pressed={filter === id}
                className={filter === id ? "is-active" : undefined}
                onClick={() => setFilter(id)}
              >
                {label}
                <span aria-hidden="true">{counts[id]}</span>
                <span className="sr-only">，{counts[id]} 个</span>
              </button>
            ))}
          </div>
        </div>
        <p className="sr-only" role="status">
          找到 {results.length} 个预设
        </p>
        {results.length ? (
          <ul
            ref={listRef}
            className="preset-list"
            aria-label="预设列表"
            onKeyDown={onListKeyDown}
          >
            {results.map((entry) => {
              const placeholder = endpointPlaceholder(entry.baseUrl);
              const isCurrent = current === entry.preset.name;
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="preset-row"
                    aria-current={isCurrent ? "true" : undefined}
                    onClick={() => pick(entry)}
                  >
                    <span
                      className="preset-badge"
                      aria-hidden="true"
                      style={{ background: badgeColor(entry.id) }}
                    >
                      {markOf(entry.preset.name)}
                    </span>
                    <span className="preset-text">
                      <b>{entry.preset.name}</b>
                      <small>
                        {placeholder
                          ? "需要填写你自己的地址"
                          : [entry.host, entry.model]
                              .filter(Boolean)
                              .join(" · ")}
                      </small>
                    </span>
                    <span className="preset-tags">
                      {entry.builtin && (
                        <i className="preset-tag is-builtin">内置</i>
                      )}
                      {!entry.builtin && filter === "all" && (
                        <i className="preset-tag">
                          {PRESET_GROUP_LABELS[entry.group]}
                        </i>
                      )}
                      {placeholder && (
                        <i className="preset-tag is-warn">需补全地址</i>
                      )}
                      {isCurrent && (
                        <Check
                          size={15}
                          className="preset-current"
                          aria-label="当前所选"
                        />
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="preset-empty">
            <b>没有匹配的预设</b>
            <p>试试厂商名、域名或模型名；也可以直接手动填写。</p>
            {query && (
              <button
                type="button"
                className="secondary compact"
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                  searchRef.current?.focus();
                }}
              >
                清除搜索
              </button>
            )}
          </div>
        )}
        <footer className="preset-picker-foot">
          <span>列表里没有？</span>
          <button
            type="button"
            className="secondary compact"
            onClick={() => onPick(blankSelection())}
          >
            自定义线路，手动填写
          </button>
        </footer>
      </section>
    </div>
  );
}
