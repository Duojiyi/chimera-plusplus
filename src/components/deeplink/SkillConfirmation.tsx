import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import type { DeepLinkImportRequest } from "@/lib/api/deeplink";

export function SkillConfirmation({
  request,
  state,
}: {
  request: DeepLinkImportRequest;
  /** Whether the backend preview has loaded, or refused the link. */
  state: "loading" | "ready" | "failed";
}) {
  const { t } = useTranslation();
  const ids = useId();

  return (
    <>
      <dl className="dl-facts">
        <dt>{t("deeplink.skill.repo")}</dt>
        <dd className="dl-mono dl-strong">{request.repo}</dd>
        <dt>{t("deeplink.skill.branch")}</dt>
        <dd className="dl-mono">{request.branch || "main"}</dd>
        {request.directory && (
          <>
            <dt>{t("deeplink.skill.directory")}</dt>
            <dd className="dl-mono">{request.directory}</dd>
          </>
        )}
      </dl>

      {/* Skill repositories always import disabled (MH-4). */}
      {state === "ready" && (
        <section className="dl-section" aria-labelledby={`${ids}-outcome`}>
          <h3 id={`${ids}-outcome`} className="dl-section-title">
            确认后
          </h3>
          <div className="dl-card">
            <ul className="dl-outcome">
              <li>
                <Check size={14} aria-hidden="true" />
                <span>{t("deeplink.skill.hint")}</span>
              </li>
            </ul>
            <p className="dl-card-note">{t("deeplink.skill.hintDetail")}</p>
          </div>
        </section>
      )}
    </>
  );
}
