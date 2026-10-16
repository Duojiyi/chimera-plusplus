import { useId } from "react";
import { useTranslation } from "react-i18next";
import { EditorLabel } from "@/components/providers/ProviderEditorFields";
import {
  parseBodyOverrideJson,
  parseHeaderOverrideJson,
} from "@/lib/requestOverrides";

interface LocalProxyRequestOverridesFieldProps {
  headersJson: string;
  bodyJson: string;
  onHeadersJsonChange: (value: string) => void;
  onBodyJsonChange: (value: string) => void;
}

export function LocalProxyRequestOverridesField({
  headersJson,
  bodyJson,
  onHeadersJsonChange,
  onBodyJsonChange,
}: LocalProxyRequestOverridesFieldProps) {
  const { t } = useTranslation();
  const id = useId();
  const headerError = parseHeaderOverrideJson(headersJson).error;
  const bodyError = parseBodyOverrideJson(bodyJson).error;

  return (
    <div className="editor-field">
      <EditorLabel
        id={`${id}-title`}
        label={t("providerForm.localProxyRequestOverrides", {
          defaultValue: "本地代理请求覆盖",
        })}
      />
      <small>
        {t("providerForm.localProxyRequestOverridesHint", {
          defaultValue:
            "仅在本地路由/代理接管后生效，应用于协议转换后的上游请求。",
        })}
      </small>

      <div className="editor-override-grid">
        <div className="editor-field">
          <EditorLabel
            htmlFor={`${id}-headers`}
            label={t("providerForm.localProxyHeaderOverrides", {
              defaultValue: "Header 覆盖",
            })}
          />
          <textarea
            id={`${id}-headers`}
            className="editor-code"
            value={headersJson}
            onChange={(event) => onHeadersJsonChange(event.target.value)}
            placeholder={'{\n  "X-Provider": "chimera"\n}'}
            spellCheck={false}
            aria-invalid={Boolean(headerError)}
            aria-describedby={headerError ? `${id}-headers-error` : undefined}
          />
          {headerError && (
            <small id={`${id}-headers-error`} className="is-error">
              {t("providerForm.localProxyHeaderOverridesInvalidDetail", {
                error: headerError,
                defaultValue: "Header 覆盖格式错误：{{error}}",
              })}
            </small>
          )}
        </div>

        <div className="editor-field">
          <EditorLabel
            htmlFor={`${id}-body`}
            label={t("providerForm.localProxyBodyOverrides", {
              defaultValue: "Body 覆盖",
            })}
          />
          <textarea
            id={`${id}-body`}
            className="editor-code"
            value={bodyJson}
            onChange={(event) => onBodyJsonChange(event.target.value)}
            placeholder={'{\n  "temperature": 0.2\n}'}
            spellCheck={false}
            aria-invalid={Boolean(bodyError)}
            aria-describedby={bodyError ? `${id}-body-error` : undefined}
          />
          {bodyError && (
            <small id={`${id}-body-error`} className="is-error">
              {t("providerForm.localProxyBodyOverridesInvalidDetail", {
                error: bodyError,
                defaultValue: "Body 覆盖格式错误：{{error}}",
              })}
            </small>
          )}
        </div>
      </div>
    </div>
  );
}
