import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ChevronLeft } from "lucide-react";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import {
  EditorInUseNotice,
  EditorSaveActions,
  EditorTestAction,
  SaveLabel,
  useAddressTest,
} from "@/components/providers/ProviderEditorFields";
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

/**
 * Line editor of Claude Desktop and Grok Build. It uses the line editor shell
 * of the other tools (back pill, line name with "工具 · 新建线路", sections,
 * footer) around the tool's own form.
 */
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
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [draftName, setDraftName] = useState(provider?.name ?? "");
  const [draftUrl, setDraftUrl] = useState<string | null>(null);
  const [inUse, setInUse] = useState(false);
  const { connection, test, reset } = useAddressTest();
  const toolName = additionalToolNames[appId];
  useLightweightCloseBlocker(busy || dirty);
  // Saving the line the tool uses also rewrites its live config; the editor
  // says so above the form. Only a notice, so a failed read stays silent.
  useEffect(() => {
    if (!provider) return;
    let active = true;
    providersApi
      .getCurrent(appId)
      .then((current) => {
        if (active) setInUse(current === provider.id);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [appId, provider]);
  useEffect(() => {
    reset();
  }, [draftUrl, reset]);
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmClose(true);
    else onClose();
  };
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
      onClose={requestClose}
      title={`${provider ? "编辑" : "添加"} ${toolName} 线路`}
      editorHeader={
        <>
          <button
            type="button"
            className="secondary editor-back"
            aria-label="返回线路"
            disabled={busy}
            onClick={requestClose}
          >
            <ChevronLeft size={16} aria-hidden="true" /> 线路
          </button>
          <div className="editor-heading">
            <h2>{draftName.trim() || "未命名线路"}</h2>
            <span>
              {toolName} · {provider ? "编辑线路" : "新建线路"}
            </span>
          </div>
          <span className="editor-draft-status" role="status">
            {busy ? "正在保存…" : dirty ? "未保存修改" : ""}
          </span>
        </>
      }
      footer={
        <>
          {draftUrl !== null && (
            <EditorTestAction
              connection={connection}
              onTest={() => void test(draftUrl)}
              disabled={busy}
            />
          )}
          <EditorSaveActions
            note={
              !provider
                ? "仅保存，稍后在列表中切换"
                : inUse
                  ? undefined
                  : "仅保存，不切换到这条线路"
            }
            onCancel={requestClose}
            disabled={busy}
          >
            <button
              type="submit"
              className="primary"
              form="provider-form"
              disabled={busy}
            >
              <SaveLabel busy={busy} label="保存线路" />
            </button>
          </EditorSaveActions>
        </>
      }
    >
      {inUse && (
        <EditorInUseNotice>
          这是正在使用的线路。保存后同步写入 {toolName} 的配置。
        </EditorInUseNotice>
      )}
      <div onChangeCapture={() => setDirty(true)}>
        <ProviderForm
          appId={appId}
          providerId={provider?.id}
          initialData={provider ?? undefined}
          submitLabel="保存线路"
          showButtons={false}
          onSubmit={save}
          onCancel={requestClose}
          onSubmittingChange={setBusy}
          onDirtyChange={() => setDirty(true)}
          onNameChange={setDraftName}
          onBaseUrlChange={setDraftUrl}
        />
      </div>
      {connection.kind === "error" && (
        <p className="editor-feedback" role="alert">
          {connection.message}
        </p>
      )}
      <ConfirmDialog
        isOpen={confirmClose}
        title="放弃未保存的修改？"
        message="此线路的修改尚未保存。离开后将丢失这些修改。"
        confirmText="放弃修改"
        cancelText="继续编辑"
        onConfirm={onClose}
        onCancel={() => setConfirmClose(false)}
      />
    </FullScreenPanel>
  );
}
