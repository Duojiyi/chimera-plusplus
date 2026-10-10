import { getChimeraHubTemplate } from "@/config/codexTemplates";

export function CodexPresetStart({ onRestore }: { onRestore: () => void }) {
  return (
    <div className="editor-template-actions">
      <div className="editor-template-text">
        <b>配置模板 · {getChimeraHubTemplate().name}</b>
        <small>已预填 Chimera 地址，可手动修改；请填写自己的 API Key。</small>
      </div>
      <button type="button" className="secondary compact" onClick={onRestore}>
        恢复 Chimera 模板
      </button>
    </div>
  );
}
