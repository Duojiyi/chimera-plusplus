import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  Check,
  ChevronDown,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type { CodexCatalogModel } from "@/types";
import type { FetchedModel } from "@/lib/api/model-fetch";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import {
  applyCodexMappingSelection,
  codexModelKey,
  isCustomizedCatalogRow,
  isLikelyNonChatModel,
} from "@/chimeraUtils";
import "./CodexModelPicker.css";

export interface CodexModelPickerProps {
  models: FetchedModel[];
  /** The draft's default model. */
  defaultModel: string;
  /** The draft's mapping rows. */
  rows: CodexCatalogModel[];
  /** Default model filled in from this list because the field was empty. */
  suggestedModel?: string | null;
  refetching: boolean;
  /** A row was clicked: the new default plus the rows with any checkbox changes. */
  onPick: (model: string, rows: CodexCatalogModel[]) => void;
  onApply: (rows: CodexCatalogModel[]) => void;
  onRefetch: () => void;
  onClose: () => void;
}

/**
 * The fetched model list of a Codex line. Clicking a model makes it the
 * default; the checkbox adds or removes a mapping row, committed by 应用 (or by
 * picking a default) and discarded by 取消.
 */
export function CodexModelPicker({
  models,
  defaultModel,
  rows,
  suggestedModel,
  refetching,
  onPick,
  onApply,
  onRefetch,
  onClose,
}: CodexModelPickerProps) {
  const dialogRef = useDialogFocus<HTMLElement>(onClose);
  const searchRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const [query, setQuery] = useState("");
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const rowsByKey = useMemo(
    () => new Map(rows.map((row) => [codexModelKey(row.model), row])),
    [rows],
  );
  const defaultKey = codexModelKey(defaultModel);
  const [nonChatOpen, setNonChatOpen] = useState(() =>
    isLikelyNonChatModel(defaultModel),
  );

  const isLocked = (key: string) => {
    const row = rowsByKey.get(key);
    return Boolean(row && isCustomizedCatalogRow(row));
  };
  const isChecked = (key: string) => toggled.get(key) ?? rowsByKey.has(key);
  const checked = new Set(
    models.map((model) => codexModelKey(model.id)).filter(isChecked),
  );
  const changed = models.some((model) => {
    const key = codexModelKey(model.id);
    return isChecked(key) !== rowsByKey.has(key);
  });
  const nextRows = () =>
    changed
      ? applyCodexMappingSelection(
          rows,
          models.map((model) => model.id),
          checked,
        )
      : rows;

  const needle = query.trim().toLocaleLowerCase("en-US");
  const matches = (model: FetchedModel) =>
    !needle ||
    model.id.toLocaleLowerCase("en-US").includes(needle) ||
    (model.ownedBy ?? "").toLocaleLowerCase("en-US").includes(needle);
  const chat = models.filter(
    (model) => !isLikelyNonChatModel(model.id) && matches(model),
  );
  const nonChat = models.filter(
    (model) => isLikelyNonChatModel(model.id) && matches(model),
  );
  // A search shows every match, and a list with only non-chat models has
  // nothing else to show.
  const showNonChat = nonChatOpen || Boolean(needle) || chat.length === 0;
  const lockedCount = models.filter((model) =>
    isLocked(codexModelKey(model.id)),
  ).length;

  // ↑↓ walk the visible models; ↑ from the first one returns to the search.
  const onListKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = Array.from(
      dialogRef.current?.querySelectorAll<HTMLButtonElement>(
        ".model-picker-pick",
      ) ?? [],
    );
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      buttons[Math.min(index + 1, buttons.length - 1)].focus();
    } else if (index <= 0) {
      searchRef.current?.focus();
    } else {
      buttons[index - 1].focus();
    }
  };

  const renderRow = (model: FetchedModel, index: number) => {
    const key = codexModelKey(model.id);
    const locked = isLocked(key);
    const isDefault = key === defaultKey;
    const describedBy = [
      model.ownedBy && `${baseId}-owner-${index}`,
      isDefault && `${baseId}-default`,
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <li
        key={model.id}
        className={`model-picker-row${isDefault ? " is-default" : ""}`}
      >
        <label className="model-picker-check">
          <input
            type="checkbox"
            aria-label={`加入模型映射：${model.id}`}
            aria-describedby={locked ? `${baseId}-locked` : undefined}
            checked={isChecked(key)}
            disabled={locked}
            onChange={(event) =>
              setToggled((current) =>
                new Map(current).set(key, event.target.checked),
              )
            }
          />
        </label>
        <button
          type="button"
          className="model-picker-pick"
          aria-describedby={describedBy || undefined}
          onClick={() => onPick(model.id, nextRows())}
        >
          <span className="model-picker-id">{model.id}</span>
          {locked && (
            <span className="model-picker-tag" aria-hidden="true">
              已自定义
            </span>
          )}
          {isDefault && (
            <span className="model-picker-default" aria-hidden="true">
              <Check size={14} />
              默认
            </span>
          )}
          <span
            className="model-picker-owner"
            id={model.ownedBy ? `${baseId}-owner-${index}` : undefined}
            aria-hidden="true"
          >
            {model.ownedBy ?? ""}
          </span>
        </button>
      </li>
    );
  };

  const total = models.length;
  const shown = chat.length + nonChat.length;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        ref={dialogRef}
        className="model-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${baseId}-title`}
        aria-describedby={`${baseId}-description`}
        tabIndex={-1}
        onKeyDown={onListKeyDown}
      >
        <header className="model-picker-header">
          <div>
            <h2 id={`${baseId}-title`}>选择模型</h2>
            <p id={`${baseId}-description`}>
              {suggestedModel
                ? `已按列表建议默认模型 ${suggestedModel}。`
                : "列表来自此线路的模型接口。"}
              点击模型设为默认，勾选加入模型映射。
            </p>
          </div>
          <button
            type="button"
            className="secondary compact"
            onClick={onRefetch}
            disabled={refetching}
          >
            {refetching ? (
              <LoaderCircle className="spin" size={14} aria-hidden="true" />
            ) : (
              <RefreshCw size={14} aria-hidden="true" />
            )}
            {refetching ? "正在获取…" : "重新获取"}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭模型列表"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="model-picker-toolbar">
          <label className="model-picker-search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              data-autofocus
              aria-label="搜索模型"
              placeholder="搜索模型或提供方"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
            />
          </label>
          <span className="model-picker-count" aria-live="polite">
            {needle ? `找到 ${shown} 个 · 共 ${total} 个` : `共 ${total} 个`}
            {` · 已加入映射 ${checked.size} 个`}
          </span>
        </div>
        <div className="model-picker-body">
          {shown === 0 && (
            <p className="model-picker-empty">
              没有匹配“{query.trim()}”的模型。
            </p>
          )}
          {chat.length > 0 && (
            <ul className="model-picker-list" aria-label="对话模型">
              {chat.map(renderRow)}
            </ul>
          )}
          {nonChat.length > 0 && (
            <div className="model-picker-group">
              {needle || chat.length === 0 ? (
                <p className="model-picker-group-title">
                  非对话模型 {nonChat.length} 个
                </p>
              ) : (
                <button
                  type="button"
                  className="model-picker-group-toggle"
                  aria-expanded={showNonChat}
                  onClick={() => setNonChatOpen(!nonChatOpen)}
                >
                  <ChevronDown size={14} aria-hidden="true" />
                  非对话模型 {nonChat.length} 个
                  <small>嵌入、重排、语音、图像等，通常不用于 Codex</small>
                </button>
              )}
              {showNonChat && (
                <ul className="model-picker-list" aria-label="非对话模型">
                  {nonChat.map((model, index) =>
                    renderRow(model, chat.length + index),
                  )}
                </ul>
              )}
            </div>
          )}
          <span id={`${baseId}-default`} hidden>
            当前默认模型
          </span>
          <span id={`${baseId}-locked`} hidden>
            已自定义的映射，请在模型映射表中删除
          </span>
        </div>
        <footer className="model-picker-footer">
          <p>
            {lockedCount
              ? "“已自定义”的模型需在映射表中删除。"
              : "勾选的模型会加入模型映射。"}
          </p>
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={!changed}
            onClick={() => onApply(nextRows())}
          >
            应用
          </button>
        </footer>
      </section>
    </div>
  );
}
