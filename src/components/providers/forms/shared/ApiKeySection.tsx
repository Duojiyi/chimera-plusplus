import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ApiKeyInput from "../ApiKeyInput";
import type { ProviderCategory } from "@/types";

interface ApiKeySectionProps {
  id?: string;
  label?: string;
  value: string;
  onChange: (value: string) => void;
  category?: ProviderCategory;
  shouldShowLink: boolean;
  websiteUrl: string;
  placeholder?: {
    official: string;
    thirdParty: string;
  };
  disabled?: boolean;
  isPartner?: boolean;
  partnerPromotionKey?: string;
  help?: ReactNode;
}

export function ApiKeySection({
  id,
  label,
  value,
  onChange,
  category,
  shouldShowLink,
  websiteUrl,
  placeholder,
  disabled,
  help,
}: ApiKeySectionProps) {
  const { t } = useTranslation();

  const defaultPlaceholder = {
    official: t("providerForm.officialNoApiKey", {
      defaultValue: "官方供应商无需 API Key",
    }),
    thirdParty: t("providerForm.apiKeyAutoFill", {
      defaultValue: "输入 API Key，将自动填充到配置",
    }),
  };

  const finalPlaceholder = placeholder || defaultPlaceholder;

  return (
    <ApiKeyInput
      id={id}
      label={label}
      value={value}
      onChange={onChange}
      placeholder={
        category === "official"
          ? finalPlaceholder.official
          : finalPlaceholder.thirdParty
      }
      disabled={disabled ?? category === "official"}
      help={help}
      hint={
        shouldShowLink && websiteUrl ? (
          <a
            href={websiteUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="link-button"
          >
            {t("providerForm.getApiKey", {
              defaultValue: "获取 API Key",
            })}
          </a>
        ) : undefined
      }
    />
  );
}
