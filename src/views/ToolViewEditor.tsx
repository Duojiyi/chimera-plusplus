import ToolViewMiniMaxForm from "./ToolViewMiniMaxForm";
import { useState } from "react";
import { toast } from "sonner";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import {
  ProviderForm,
  type ProviderFormValues,
} from "@/components/providers/forms/ProviderForm";
import { providersApi } from "@/lib/api/providers";
import type { Provider } from "@/types";
import {
  additionalToolNames,
  type AdditionalToolAppId,
} from "@/utils/toolProviderConfig";
import { generateUUID } from "@/utils/uuid";

export default function ToolViewEditor({
  appId,
  provider,
  onClose,
  onSaved,
}: {
  appId: AdditionalToolAppId;
  provider: Provider | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const save = async (values: ProviderFormValues) => {
    try {
      if (
        !provider &&
        values.presetCategory === "official" &&
        (appId === "claude-desktop" || appId === "grokbuild")
      ) {
        if (appId === "claude-desktop")
          await providersApi.ensureClaudeDesktopOfficialProvider();
        else await providersApi.ensureGrokBuildOfficialProvider();
        toast.success("官方配置入口已添加，尚未切换或登录");
        onSaved();
        onClose();
        return;
      }
      const next: Provider = {
        ...provider,
        id: values.providerKey?.trim() || provider?.id || generateUUID(),
        name: values.name.trim(),
        settingsConfig: JSON.parse(values.settingsConfig),
        websiteUrl: values.websiteUrl?.trim(),
        notes: values.notes?.trim(),
        icon: values.icon,
        iconColor: values.iconColor,
        category: values.presetCategory ?? provider?.category,
        meta: {
          ...provider?.meta,
          ...values.meta,
          ...(!provider ? { liveConfigManaged: false } : {}),
        },
      };
      // Creating a saved line is not consent to write the tool's live config.
      const saved = provider
        ? await providersApi.update(next, appId, provider.id)
        : await providersApi.add(next, appId, false);
      if (!saved) throw new Error("保存未成功，请重试");
      toast.success(
        provider
          ? "线路已保存；已启用线路可能同步更新本机配置"
          : "线路已保存；请在列表中显式切换或启用",
      );
      onSaved();
      onClose();
    } catch (error) {
      toast.error("保存失败", { description: String(error) });
      throw error;
    }
  };
  return (
    <FullScreenPanel
      isOpen
      onClose={() => {
        if (!busy) onClose();
      }}
      title={`${provider ? "编辑" : "添加"} ${additionalToolNames[appId]} 线路`}
    >
      {appId === "mcode" ? (
        <ToolViewMiniMaxForm
          provider={provider}
          onSubmit={save}
          onCancel={onClose}
          onSubmittingChange={setBusy}
        />
      ) : (
        <ProviderForm
          appId={appId}
          providerId={provider?.id}
          initialData={provider ?? undefined}
          submitLabel="保存线路"
          onSubmit={save}
          onCancel={onClose}
          onSubmittingChange={setBusy}
        />
      )}
    </FullScreenPanel>
  );
}
