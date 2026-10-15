import React, { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EditorLabel } from "@/components/providers/ProviderEditorFields";

interface ApiKeyInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  label?: string;
  id?: string;
  /** Visible line under the field, such as where to get a key. */
  hint?: React.ReactNode;
}

/** The line editor's key field: masked input with a show/hide side button. */
const ApiKeyInput: React.FC<ApiKeyInputProps> = ({
  value,
  onChange,
  placeholder,
  disabled = false,
  required = false,
  label = "API Key",
  id = "apiKey",
  hint,
}) => {
  const { t } = useTranslation();
  const [showKey, setShowKey] = useState(false);
  const hintId = hint ? `${id}-hint` : undefined;

  return (
    <div className="editor-field">
      <EditorLabel htmlFor={id} label={required ? `${label} *` : label} />
      <div className="password-field">
        <input
          type={showKey ? "text" : "password"}
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? t("apiKeyInput.placeholder")}
          disabled={disabled}
          required={required}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={hintId}
        />
        <button
          type="button"
          onClick={() => setShowKey(!showKey)}
          disabled={disabled}
          aria-label={showKey ? t("apiKeyInput.hide") : t("apiKeyInput.show")}
          title={showKey ? t("apiKeyInput.hide") : t("apiKeyInput.show")}
        >
          {showKey ? (
            <EyeOff size={16} aria-hidden="true" />
          ) : (
            <Eye size={16} aria-hidden="true" />
          )}
        </button>
      </div>
      {hint && <small id={hintId}>{hint}</small>}
    </div>
  );
};

export default ApiKeyInput;
