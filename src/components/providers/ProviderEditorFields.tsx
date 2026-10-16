import {
  forwardRef,
  useCallback,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Info,
  LoaderCircle,
} from "lucide-react";
import { HelpTip } from "@/components/ui/help-tip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ConnectionState } from "@/chimeraUtils";
import { vscodeApi } from "@/lib/api/vscode";
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
  role,
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
  /** Announce the row as a switch (it is drawn as one) instead of a checkbox. */
  role?: "switch";
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
        role={role}
        checked={checked}
        disabled={disabled}
        aria-describedby={noteId}
        onChange={(event) => onChange(event.target.checked)}
      />
    </div>
  );
}

/** `[value, label, note]`; the note is read as the option's description. */
export type EditorChoiceOption<T extends string> = readonly [
  value: T,
  label: string,
  note?: string,
];

/** The editors' segmented single choice (协议, 认证方式, …): a radio group
 * drawn as one control, with the result line passed as children. */
export function EditorChoice<T extends string>({
  name,
  label,
  help,
  value,
  options,
  onChange,
  disabled,
  children,
}: {
  /** Radio group name and id prefix. */
  name: string;
  label: string;
  help?: ReactNode;
  value: string;
  options: ReadonlyArray<EditorChoiceOption<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="editor-format">
      <EditorLabel id={`${name}-label`} label={label} help={help} />
      <div
        className="editor-format-options"
        role="radiogroup"
        aria-labelledby={`${name}-label`}
      >
        {options.map(([option, text, note], index) => (
          <label key={option} className="editor-format-option">
            <input
              type="radio"
              name={name}
              value={option}
              checked={value === option}
              disabled={disabled}
              onChange={() => onChange(option)}
              aria-labelledby={`${name}-${index}`}
              aria-describedby={note ? `${name}-${index}-note` : undefined}
            />
            <span className="editor-format-option-text">
              <b id={`${name}-${index}`}>{text}</b>
              {note && <small id={`${name}-${index}-note`}>{note}</small>}
            </span>
          </label>
        ))}
      </div>
      {children}
    </div>
  );
}

/** Upstream protocols the local router converts, as the protocol notes say. */
export const ROUTED_PROTOCOL_NOTE = "经本地路由转换，需保持 Chimera++ 运行";

/** One wording for the Anthropic credential header in every editor. */
export const ANTHROPIC_AUTH_OPTIONS = [
  ["ANTHROPIC_AUTH_TOKEN", "Authorization: Bearer", "ANTHROPIC_AUTH_TOKEN"],
  ["ANTHROPIC_API_KEY", "x-api-key", "ANTHROPIC_API_KEY"],
] as const;
export const ANTHROPIC_AUTH_HELP =
  "网关接收密钥的请求头，两者只发其一：Authorization: Bearer 对应 ANTHROPIC_AUTH_TOKEN，x-api-key 对应 ANTHROPIC_API_KEY。";

export const PROMPT_CACHE_OPTIONS = [
  ["auto", "自动（推荐）"],
  ["enabled", "开启"],
  ["disabled", "关闭"],
] as const;

// Radix reserves "" for "no selection"; an option that means "none" maps to
// this value instead.
const EMPTY_OPTION = "__none__";

/** The editors' select: the app's styled list instead of OS chrome. */
export function EditorSelect({
  id,
  value,
  options,
  onChange,
  disabled,
  label,
  placeholder,
}: {
  id?: string;
  value: string;
  options: ReadonlyArray<readonly [value: string, label: ReactNode]>;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Accessible name when no `<label htmlFor>` names the trigger. */
  label?: string;
  placeholder?: string;
}) {
  const hasEmpty = options.some(([option]) => option === "");
  return (
    <Select
      value={value === "" && hasEmpty ? EMPTY_OPTION : value}
      onValueChange={(next) => onChange(next === EMPTY_OPTION ? "" : next)}
      disabled={disabled}
    >
      <SelectTrigger id={id} className="editor-select" aria-label={label}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map(([option, text]) => (
          <SelectItem
            key={option || EMPTY_OPTION}
            value={option || EMPTY_OPTION}
          >
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The 高级 card every editor folds its tool-specific settings into; the
 * summary names what is switched on while it is closed. */
export const EditorAdvanced = forwardRef<
  HTMLDetailsElement,
  {
    title?: string;
    summary: ReactNode;
    /** Controlled open state; leave out to let the card keep its own. */
    open?: boolean;
    onToggle?: (open: boolean) => void;
    className?: string;
    children: ReactNode;
  }
>(function EditorAdvanced(
  { title = "高级配置", summary, open, onToggle, className, children },
  ref,
) {
  return (
    <details
      ref={ref}
      className={
        className ? `advanced-options ${className}` : "advanced-options"
      }
      open={open}
      onToggle={
        onToggle ? (event) => onToggle(event.currentTarget.open) : undefined
      }
    >
      <summary>
        <span className="advanced-summary-copy">
          <b>{title}</b>
          <small>{summary}</small>
        </span>
        <span className="advanced-summary-action">
          <span className="when-collapsed">展开</span>
          <span className="when-expanded">收起</span>
          <ChevronDown size={18} aria-hidden="true" />
        </span>
      </summary>
      <div className="advanced-options-body">{children}</div>
    </details>
  );
});

/** Template card of a new line: title, one-line hint, one action. */
export function EditorTemplateCard({
  name,
  onRestore,
  disabled,
}: {
  name: string;
  onRestore: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="editor-template-actions">
      <div className="editor-template-text">
        <b>配置模板 · {name}</b>
        <small>已预填 Chimera 地址，可手动修改；请填写自己的 API Key。</small>
      </div>
      <button
        type="button"
        className="secondary compact"
        onClick={onRestore}
        disabled={disabled}
      >
        恢复 Chimera 模板
      </button>
    </div>
  );
}

/** One quiet line above the form when the line being edited is in use. */
export function EditorInUseNotice({ children }: { children: ReactNode }) {
  return (
    <p className="editor-model-notice" role="note">
      <Info size={15} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/** A 1M context checkbox in a model row. */
export function OneMCheck({
  label,
  checked,
  disabled,
  onChange,
}: {
  /** The row it declares for, e.g. "Sonnet"; named "<label> 声明支持 1M". */
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="mapping-check">
      <input
        type="checkbox"
        aria-label={`${label} 声明支持 1M`}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      1M
    </label>
  );
}

const IDLE_CONNECTION: ConnectionState = {
  kind: "unknown",
  message: "尚未测试",
};

/** 测试地址连通性 for an editor that owns no connection state: URL only,
 * the same request and wording as the line editor's. */
export function useAddressTest() {
  const [connection, setConnection] =
    useState<ConnectionState>(IDLE_CONNECTION);
  const seq = useRef(0);
  const test = useCallback(async (url: string) => {
    const id = ++seq.current;
    if (!url.trim()) {
      setConnection({ kind: "error", message: "请先填写 API 请求地址" });
      return;
    }
    setConnection({ kind: "checking", message: "正在测试 API 地址" });
    try {
      const [result] = await vscodeApi.testApiEndpoints([url.trim()], {
        timeoutSecs: 12,
      });
      if (id !== seq.current) return;
      if (!result || result.latency == null)
        throw new Error(result?.error || "服务未响应");
      setConnection({
        kind: "connected",
        message: `${result.latency}ms`,
        modelCount: 0,
        latencyMs: result.latency,
      });
      toast.success("地址可达", {
        description: `响应时间 ${result.latency} ms · 未验证密钥或模型`,
      });
    } catch (error) {
      if (id !== seq.current) return;
      setConnection({ kind: "error", message: String(error) });
      toast.error("连接测试失败", { description: String(error) });
    }
  }, []);
  // A changed address makes the last result meaningless.
  const reset = useCallback(() => {
    seq.current += 1;
    setConnection(IDLE_CONNECTION);
  }, []);
  return { connection, test, reset };
}

/** Footer, left: the address test and what it found. */
export function EditorTestAction({
  connection,
  onTest,
  disabled,
}: {
  connection: ConnectionState;
  onTest: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="editor-test-actions">
      <button
        type="button"
        className="secondary"
        onClick={onTest}
        disabled={disabled || connection.kind === "checking"}
      >
        测试地址连通性
      </button>
      <small
        className={`editor-connection is-${connection.kind}`}
        role="status"
      >
        {connection.kind === "error"
          ? "连接失败，详见正文"
          : connection.kind === "unknown"
            ? "仅测试地址连通性，不验证密钥或模型"
            : connection.kind === "connected" && connection.latencyMs != null
              ? `地址可达 · ${connection.latencyMs} ms`
              : connection.message}
      </small>
    </div>
  );
}

/** Footer, right: what saving does when the label alone cannot say it, then
 * 取消 and the primary button. */
export function EditorSaveActions({
  note,
  onCancel,
  disabled,
  children,
}: {
  note?: ReactNode;
  onCancel: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="editor-save-actions">
      {note && <small className="editor-save-note">{note}</small>}
      <button
        type="button"
        className="secondary"
        onClick={onCancel}
        disabled={disabled}
      >
        取消
      </button>
      {children}
    </div>
  );
}

/** The primary button's text while saving. */
export function SaveLabel({ busy, label }: { busy: boolean; label: string }) {
  return busy ? (
    <>
      <LoaderCircle className="spin" size={15} aria-hidden="true" /> 正在保存…
    </>
  ) : (
    <>{label}</>
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
  canSetModelsUrl = true,
}: {
  issue: ModelFetchIssue;
  onAction: (action: ModelFetchAction) => void;
  /** The editor has a 模型列表地址 field; otherwise retry is offered instead. */
  canSetModelsUrl?: boolean;
}) {
  if (issue.kind === "empty") {
    return (
      <p className="editor-model-notice" role="status">
        供应商没有返回可选模型，可以手动填写模型名称。
      </p>
    );
  }
  const { text, action: suggested } = MODEL_FETCH_ERRORS[issue.code];
  const action =
    suggested === "models-url" && !canSetModelsUrl ? "retry" : suggested;
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
