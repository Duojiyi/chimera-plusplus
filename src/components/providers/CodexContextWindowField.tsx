import { useId, useMemo, useRef } from "react";
import {
  applyOneMillionContext,
  readContextWindowState,
} from "@/utils/codexContextWindow";
import "./CodexContextWindowField.css";

const HELP = [
  "让 Codex 按 1,000,000 tokens 的上下文窗口使用这条线路的模型，并推迟自动压缩。",
  "仅在供应商和模型确实支持 1M 时开启，否则请求可能失败。未单独填写上下文的模型映射，默认窗口也会改为 1M。",
];

export interface CodexContextWindowFieldProps {
  /** The line's own config.toml text. */
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}

/** The "1M 上下文" switch of a Codex line; edits only the line's config text. */
export function CodexContextWindowField({
  value,
  onChange,
  disabled = false,
}: CodexContextWindowFieldProps) {
  const id = useId();
  const state = useMemo(() => readContextWindowState(value), [value]);
  // Turning on overwrites a hand-set window. Remember the text it replaced so
  // turning straight back off restores it instead of dropping the window.
  const undo = useRef<{ before: string; after: string } | null>(null);
  const describedBy = [
    `${id}-help`,
    state.hasCustomValues && `${id}-note`,
    !state.editable && `${id}-error`,
  ]
    .filter(Boolean)
    .join(" ");

  const toggle = () => {
    if (state.enabled) {
      const saved = undo.current;
      undo.current = null;
      onChange(
        saved?.after === value
          ? saved.before
          : applyOneMillionContext(value, false),
      );
      return;
    }
    const next = applyOneMillionContext(value, true);
    undo.current = { before: value, after: next };
    onChange(next);
  };

  return (
    <div className="codex-context-field toggle-field">
      <div className="codex-context-field-text">
        <b id={`${id}-label`}>1M 上下文</b>
        <div id={`${id}-help`} className="codex-context-field-help">
          {HELP.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        className="codex-context-field-switch"
        aria-checked={state.enabled}
        aria-labelledby={`${id}-label`}
        aria-describedby={describedBy}
        disabled={disabled || !state.editable}
        onClick={toggle}
      >
        <span className="codex-context-field-track" aria-hidden="true">
          <span className="codex-context-field-thumb" />
        </span>
      </button>
      {state.hasCustomValues && (
        <p id={`${id}-note`} className="codex-context-field-note">
          检测到手动设置的上下文值，关闭开关不会改动它们。
        </p>
      )}
      {!state.editable && (
        <p id={`${id}-error`} className="codex-context-field-error">
          配置文本有误，修正后才能使用这个开关。
        </p>
      )}
    </div>
  );
}
