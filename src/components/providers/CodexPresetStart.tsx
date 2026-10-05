import { lazy, Suspense, useState } from "react";
import { toast } from "sonner";
import { settingsApi } from "@/lib/api/settings";
import type { PresetSelection } from "@/utils/codexPresetDraft";

// The picker pulls in the whole vendor preset list; it loads only when opened.
const CodexPresetPicker = lazy(() => import("./CodexPresetPicker"));

export type StartingPoint = Pick<
  PresetSelection,
  "label" | "hint" | "apiKeyUrl" | "endpointPlaceholder"
>;

export interface CodexPresetStartProps {
  /** The preset the draft was last seeded from; null for the default template. */
  applied: StartingPoint | null;
  /** The draft has edits that applying a preset would replace. */
  dirty: boolean;
  onPick: (selection: PresetSelection) => void;
  onRestore: () => void;
}

/** Where a new Codex line starts from, with a way to choose another preset. */
export function CodexPresetStart({
  applied,
  dirty,
  onPick,
  onRestore,
}: CodexPresetStartProps) {
  const [open, setOpen] = useState(false);

  const openKeyPage = async (url: string) => {
    try {
      await settingsApi.openExternal(url);
    } catch {
      toast.error("无法打开浏览器，请复制地址后访问");
    }
  };

  return (
    <div
      className={`editor-template-actions${applied?.endpointPlaceholder ? " has-warning" : ""}`}
    >
      <div className="editor-template-text">
        <b>{applied ? `起点：${applied.label}` : "默认模板"}</b>
        <small>
          {applied ? applied.hint : "请核对地址、模型和密钥后再保存。"}
          {applied?.apiKeyUrl && (
            <>
              {" "}
              <button
                type="button"
                className="link-button"
                onClick={() => void openKeyPage(applied.apiKeyUrl!)}
              >
                获取 API Key
              </button>
            </>
          )}
        </small>
      </div>
      <div className="editor-template-buttons">
        <button
          type="button"
          className="secondary compact"
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          {applied ? "更换预设" : "选择预设"}
        </button>
        <button type="button" className="secondary compact" onClick={onRestore}>
          恢复模板
        </button>
      </div>
      {open && (
        <Suspense fallback={null}>
          <CodexPresetPicker
            current={applied?.label ?? null}
            dirty={dirty}
            onPick={(selection) => {
              setOpen(false);
              onPick(selection);
            }}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
