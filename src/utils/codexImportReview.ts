import type { TFunction } from "i18next";
import { toast } from "sonner";
import { settingsApi } from "@/lib/api";
import type {
  CodexImportReview,
  UntrustedConfigReport,
} from "@/lib/api/settings";

export function describeCodexImportReview(
  review: CodexImportReview,
  t: TFunction,
): string[] {
  const none = t("settings.codexImportReview.none", { defaultValue: "无" });
  const line = (name: string, report: UntrustedConfigReport) =>
    t("settings.codexImportReview.line", {
      defaultValue: "{{name}}：已移除 {{removed}}；待确认 {{confirm}}",
      name,
      removed: report.stripped.join(", ") || none,
      confirm: report.needsConfirmation.join(", ") || none,
    });
  const lines = review.providers.map((provider) =>
    line(provider.name, provider),
  );
  if (review.commonConfig) {
    lines.push(
      line(
        t("settings.codexImportReview.commonConfig", {
          defaultValue: "通用配置",
        }),
        review.commonConfig,
      ),
    );
  }
  return lines;
}

/**
 * MH-13b: after an import, restore or cloud download, the backend holds back
 * the Codex live sync when the imported config needed sanitizing. Show what
 * changed (names only) and sync Codex only when the user confirms.
 */
export async function promptCodexImportReview(t: TFunction): Promise<void> {
  let review: CodexImportReview | null;
  try {
    review = await settingsApi.getCodexImportReview();
  } catch (error) {
    console.error(
      "[codexImportReview] Failed to read the import review",
      error,
    );
    return;
  }
  if (!review) return;

  toast.warning(
    t("settings.codexImportReview.title", {
      defaultValue: "导入的 Codex 配置需要确认",
    }),
    {
      description: [
        t("settings.codexImportReview.description", {
          defaultValue:
            "尚未同步到 Codex。供应商不应携带的设置已移除；未知环境变量会保留，确认后才生效。",
        }),
        ...describeCodexImportReview(review, t),
      ].join("\n"),
      duration: Infinity,
      closeButton: true,
      action: {
        label: t("settings.codexImportReview.confirm", {
          defaultValue: "确认并同步",
        }),
        onClick: () => {
          settingsApi
            .confirmCodexImportSync()
            .then(() =>
              toast.success(
                t("settings.codexImportReview.synced", {
                  defaultValue: "Codex 配置已同步",
                }),
              ),
            )
            .catch((error: unknown) =>
              toast.error(
                t("settings.codexImportReview.syncFailed", {
                  defaultValue: "Codex 同步失败：{{message}}",
                  message:
                    error instanceof Error
                      ? error.message
                      : String(error ?? ""),
                }),
              ),
            );
        },
      },
    },
  );
}
