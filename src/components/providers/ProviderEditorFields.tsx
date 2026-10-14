import type { ReactNode } from "react";
import { Check, CircleAlert } from "lucide-react";
import { HelpTip } from "@/components/ui/help-tip";
import type { ModelFetchErrorCode } from "@/lib/api/model-fetch";

/** "API 请求地址 *" → "API 请求地址说明": the help card's title and name. */
function helpTitle(label: string): string {
  return `${label
    .replace(/\s*\*$/, "")
    .replace(/（可选）$/, "")
    .trim()}说明`;
}

export interface EditorLabelProps {
  htmlFor?: string;
  id?: string;
  label: string;
  /** Inline content after the label text, such as an "实验性" tag. */
  tag?: ReactNode;
  /** Rule or terminology for the help card; consequences stay on the page. */
  help?: ReactNode;
}

/** A field label with its optional "?" card. The card sits beside the
 * `<label>`, not inside it, so it never joins the control's name. */
export function EditorLabel({
  htmlFor,
  id,
  label,
  tag,
  help,
}: EditorLabelProps) {
  return (
    <span className="editor-field-label">
      {htmlFor ? (
        <label htmlFor={htmlFor} id={id}>
          {label}
          {tag}
        </label>
      ) : (
        <span id={id}>
          {label}
          {tag}
        </span>
      )}
      {help && <HelpTip title={helpTitle(label)}>{help}</HelpTip>}
    </span>
  );
}

export function EditorField({
  label,
  htmlFor,
  help,
  hint,
  hintId,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  help?: ReactNode;
  /** Visible consequence or requirement under the control. */
  hint?: ReactNode;
  hintId?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className ? `editor-field ${className}` : "editor-field"}>
      <EditorLabel htmlFor={htmlFor} label={label} help={help} />
      {children}
      {hint && <small id={hintId}>{hint}</small>}
    </div>
  );
}

export function Field({
  label,
  name,
  value,
  onChange,
  placeholder,
  hint,
  help,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: ReactNode;
  help?: ReactNode;
}) {
  const id = `${name}-input`;
  const hintId = hint ? `${name}-hint` : undefined;
  return (
    <EditorField
      label={label}
      htmlFor={id}
      help={help}
      hint={hint}
      hintId={hintId}
    >
      <input
        id={id}
        name={name}
        aria-describedby={hintId}
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </EditorField>
  );
}

/** A switch row inside a `.toggle-list`; the whole row toggles it. */
export function EditorToggle({
  name,
  label,
  tag,
  help,
  note,
  checked,
  disabled,
  onChange,
}: {
  name: string;
  label: string;
  tag?: ReactNode;
  help?: ReactNode;
  /** Visible consequence or limit, also read as the switch's description. */
  note?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = `${name}-toggle`;
  const noteId = note ? `${name}-note` : undefined;
  return (
    <div className="toggle-field">
      <span className="toggle-field-text">
        <EditorLabel htmlFor={id} label={label} tag={tag} help={help} />
        {note && <small id={noteId}>{note}</small>}
      </span>
      <input
        id={id}
        name={name}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={noteId}
        onChange={(event) => onChange(event.target.checked)}
      />
    </div>
  );
}

/** Required fields still empty in a section, shown beside its heading. */
export function SectionStatus({ missing }: { missing: number }) {
  return missing ? (
    <span className="editor-section-status is-pending">
      待填写 {missing} 项
    </span>
  ) : (
    <span className="editor-section-status is-done">
      <Check size={13} aria-hidden="true" />
      已完成
    </span>
  );
}

export type ModelFetchIssue =
  { kind: "empty" } | { kind: "error"; code: ModelFetchErrorCode };

export type ModelFetchAction = "api-key" | "models-url" | "retry";

const MODEL_FETCH_ERRORS: Record<
  ModelFetchErrorCode,
  { text: string; action: ModelFetchAction }
> = {
  auth: {
    text: "API Key 无效或没有权限，供应商拒绝了模型列表请求。",
    action: "api-key",
  },
  endpoint: { text: "这个地址没有可用的模型列表接口。", action: "models-url" },
  parse: {
    text: "返回内容不是模型列表，可能需要单独的模型列表地址。",
    action: "models-url",
  },
  timeout: { text: "获取模型列表超时，供应商没有及时响应。", action: "retry" },
  unknown: { text: "未能获取模型列表，请检查地址和网络。", action: "retry" },
};

const MODEL_FETCH_ACTIONS: Record<ModelFetchAction, string> = {
  "api-key": "检查 API Key",
  "models-url": "填写模型列表地址",
  retry: "重试",
};

/** What went wrong with the last model-list request and the one next step. */
export function ModelFetchNotice({
  issue,
  onAction,
}: {
  issue: ModelFetchIssue;
  onAction: (action: ModelFetchAction) => void;
}) {
  if (issue.kind === "empty") {
    return (
      <p className="editor-model-notice" role="status">
        供应商没有返回可选模型，可以手动填写模型名称。
      </p>
    );
  }
  const { text, action } = MODEL_FETCH_ERRORS[issue.code];
  return (
    <p className="editor-model-notice is-error" role="alert">
      <CircleAlert size={15} aria-hidden="true" />
      <span>{text}也可以手动填写模型名称。</span>
      <button
        type="button"
        className="link-button"
        onClick={() => onAction(action)}
      >
        {MODEL_FETCH_ACTIONS[action]}
      </button>
    </p>
  );
}
