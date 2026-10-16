import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Zap } from "lucide-react";
import { EditorLabel } from "@/components/providers/ProviderEditorFields";

interface EndpointFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  hint?: string;
  fullUrlHint?: string;
  showManageButton?: boolean;
  onManageClick?: () => void;
  manageButtonLabel?: string;
  showFullUrlToggle?: boolean;
  isFullUrl?: boolean;
  onFullUrlChange?: (value: boolean) => void;
  /** Mark the label as required (" *"), like the line editor. */
  required?: boolean;
  /** The "?" card: how the tool turns this address into requests. */
  help?: ReactNode;
}

/**
 * Request address in the line editor's field markup. The label row carries
 * the 完整 URL switch and the speed-test entry so they stay next to the
 * address they change.
 */
export function EndpointField({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
  fullUrlHint,
  showManageButton = true,
  onManageClick,
  manageButtonLabel,
  showFullUrlToggle = false,
  isFullUrl = false,
  onFullUrlChange,
  required = false,
  help,
}: EndpointFieldProps) {
  const { t } = useTranslation();

  const defaultManageLabel = t("providerForm.manageAndTest", {
    defaultValue: "管理和测速",
  });
  const effectiveHint =
    showFullUrlToggle && isFullUrl
      ? fullUrlHint ||
        t("providerForm.fullUrlHint", {
          defaultValue:
            "💡 请填写完整请求 URL，并且必须开启代理后使用；代理将直接使用此 URL，不拼接路径",
        })
      : hint ||
        (showFullUrlToggle
          ? "填写基础地址（例如 https://api.chimerahub.org/v1）。仅在服务商提供包含 /responses 等请求路径的完整地址时开启完整 URL。"
          : undefined);
  const hasFullUrlToggle = showFullUrlToggle && Boolean(onFullUrlChange);
  const hasManage = showManageButton && Boolean(onManageClick);

  return (
    <div className="editor-field">
      <div className="editor-field-row">
        <EditorLabel
          htmlFor={id}
          label={required ? `${label} *` : label}
          help={help}
        />
        {(hasFullUrlToggle || hasManage) && (
          <span className="editor-field-tools">
            {hasFullUrlToggle && (
              <label className="editor-inline-switch">
                <input
                  type="checkbox"
                  role="switch"
                  checked={isFullUrl}
                  onChange={(event) => onFullUrlChange?.(event.target.checked)}
                />
                {t("providerForm.fullUrlLabel", {
                  defaultValue: "完整 URL",
                })}
              </label>
            )}
            {hasManage && (
              <button
                type="button"
                className="link-button"
                onClick={onManageClick}
              >
                <Zap size={13} aria-hidden="true" />
                {manageButtonLabel || defaultManageLabel}
              </button>
            )}
          </span>
        )}
      </div>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-describedby={effectiveHint ? `${id}-hint` : undefined}
        autoComplete="off"
        spellCheck={false}
      />
      {effectiveHint ? (
        <small
          id={`${id}-hint`}
          className={isFullUrl ? "is-warning" : undefined}
        >
          {effectiveHint.replace(/^💡\s*/, "")}
        </small>
      ) : null}
    </div>
  );
}
