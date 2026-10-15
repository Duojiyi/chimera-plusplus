import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import type { DeepLinkImportRequest } from "@/lib/api/deeplink";
import { CodeBlock } from "./CodeBlock";
import { toolName } from "./tools";

export function PromptConfirmation({
  request,
  state,
  content,
  targetPath,
}: {
  request: DeepLinkImportRequest;
  /** Whether the backend preview has loaded, or refused the link. */
  state: "loading" | "ready" | "failed";
  /** The backend preview's decoded content: exactly what will be stored. */
  content: string;
  /** The tool's prompt file, written only once the prompt is enabled. */
  targetPath?: string;
}) {
  const { t } = useTranslation();
  const ids = useId();
  const lines = content
    ? content.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").length
    : 0;
  const fileName = targetPath?.split(/[\\/]/).pop();

  return (
    <>
      <dl className="dl-facts">
        <dt>{t("deeplink.prompt.name")}</dt>
        <dd className="dl-strong">{request.name}</dd>
        <dt>{t("deeplink.prompt.app")}</dt>
        <dd>{toolName(request.app)}</dd>
        {request.description && (
          <>
            <dt>{t("deeplink.prompt.description")}</dt>
            <dd>{request.description}</dd>
          </>
        )}
      </dl>

      {state === "ready" && (
        <CodeBlock
          code={content}
          caption={`${t("deeplink.prompt.contentPreview")} · Markdown`}
          meta={`${lines} 行`}
          label={t("deeplink.prompt.contentPreview")}
          prose
        />
      )}
      {state === "loading" && <p className="dl-note">正在读取提示词内容…</p>}

      {/* Prompt links always import disabled (MH-4). */}
      {state === "ready" && (
        <section className="dl-section" aria-labelledby={`${ids}-outcome`}>
          <h3 id={`${ids}-outcome`} className="dl-section-title">
            确认后
          </h3>
          <div className="dl-card">
            <ul className="dl-outcome">
              <li>
                <Check size={14} aria-hidden="true" />
                <span>
                  保存到提示词库，保持停用
                  {fileName ? `，不会改动 ${fileName}` : ""}。
                </span>
              </li>
            </ul>
            {targetPath && (
              <div className="dl-files">
                <span className="dl-note">在「提示词」中启用后才会写入：</span>
                <ul className="dl-paths">
                  <li className="dl-mono">{targetPath}</li>
                </ul>
              </div>
            )}
          </div>
        </section>
      )}
    </>
  );
}
