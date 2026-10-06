import React, { useEffect, useState } from "react";
import { X, RotateCcw, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import MarkdownEditor from "@/components/MarkdownEditor";
import type { Prompt, PromptCategory } from "@/lib/api/prompts";

interface PromptFormModalProps {
  appName: string;
  filename: string;
  editingId?: string;
  categories: PromptCategory[];
  defaultCategoryId?: string;
  unavailable?: boolean;
  initialData?: Prompt;
  template?: { name: string; description: string; content: string };
  readOnly: boolean;
  blocked: boolean;
  onSave: (id: string, prompt: Prompt) => Promise<void>;
  onActivate: () => Promise<void>;
  onClose: () => void;
}

const PromptFormModal: React.FC<PromptFormModalProps> = ({
  appName,
  filename,
  editingId,
  categories,
  defaultCategoryId,
  unavailable,
  initialData,
  template,
  readOnly: initialReadOnly,
  blocked,
  onSave,
  onActivate,
  onClose,
}) => {
  // Initial values belong to this editing session; background refreshes must not reset a draft.
  const [name, setName] = useState(initialData?.name ?? "");
  const [description, setDescription] = useState(
    initialData?.description ?? "",
  );
  const [categoryId, setCategoryId] = useState(
    initialData?.categoryId ?? defaultCategoryId ?? "",
  );
  const categoryMissing =
    !!categoryId && !categories.some((category) => category.id === categoryId);
  const [content, setContent] = useState(initialData?.content ?? "");
  const [readOnly, setReadOnly] = useState(initialReadOnly);
  const [saving, setSaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(
    document.documentElement.classList.contains("dark"),
  );
  const dirty =
    name !== (initialData?.name ?? "") ||
    description !== (initialData?.description ?? "") ||
    content !== (initialData?.content ?? "") ||
    categoryId !== (initialData?.categoryId ?? defaultCategoryId ?? "");
  const working = saving || blocked;
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setIsDarkMode(document.documentElement.classList.contains("dark")),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  const requestClose = () => {
    if (saving) return;
    if (dirty) setDiscarding(true);
    else onClose();
  };
  const handleSave = async () => {
    if (!name.trim() || !content.trim() || working || categoryMissing) return;
    setSaving(true);
    try {
      const id = editingId || `prompt-${crypto.randomUUID()}`;
      const timestamp = Math.floor(Date.now() / 1000);
      await onSave(id, {
        id,
        templateId: initialData?.templateId,
        categoryId: categoryId || undefined,
        name: name.trim(),
        description: description.trim() || undefined,
        content,
        enabled: initialData?.enabled ?? false,
        createdAt: initialData?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
      onClose();
    } catch {
      // The parent reports a sanitized error; retain the draft for retry.
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(value) => {
          if (!value) requestClose();
        }}
      >
        <DialogContent
          className="prompt-drawer"
          onEscapeKeyDown={(event) => {
            if (saving) event.preventDefault();
          }}
        >
          <DialogHeader className="text-left">
            <div className="prompt-drawer-title">
              <DialogTitle>
                {readOnly
                  ? initialData?.name
                  : editingId || initialData
                    ? "编辑提示词"
                    : "新建提示词"}
              </DialogTitle>
              <Button
                variant="ghost"
                size="icon"
                aria-label="关闭提示词详情"
                disabled={saving}
                onClick={requestClose}
              >
                <X size={18} />
              </Button>
            </div>
            <DialogDescription>
              {appName} · {filename} ·{" "}
              {initialData?.enabled ? "已启用" : "尚未启用"}
            </DialogDescription>
          </DialogHeader>
          <div className="prompt-drawer-body">
            {unavailable && (
              <p role="alert">
                这条提示词已被删除，请关闭后刷新。未保存的正文仍保留在此处。
              </p>
            )}
            {readOnly ? (
              <>
                <p className="prompt-detail-note">
                  分类：
                  {categories.find((category) => category.id === categoryId)
                    ?.name ?? "未分类"}
                </p>
                {description && (
                  <p className="prompt-detail-description">{description}</p>
                )}
                <MarkdownEditor
                  ariaLabel="Markdown 正文"
                  value={content}
                  readOnly
                  darkMode={isDarkMode}
                  minHeight="300px"
                />
              </>
            ) : (
              <>
                <div className="prompt-form-field">
                  <Label htmlFor="prompt-name">名称</Label>
                  <Input
                    id="prompt-name"
                    value={name}
                    disabled={saving}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="例如：代码审查"
                  />
                </div>
                <div className="prompt-form-field">
                  <Label htmlFor="prompt-description">
                    描述 <span className="prompt-optional">（可选）</span>
                  </Label>
                  <Input
                    id="prompt-description"
                    value={description}
                    disabled={saving}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="用一句话说明启用后会怎样"
                  />
                </div>
                <div className="prompt-form-field">
                  <Label htmlFor="prompt-category">分类</Label>
                  <select
                    id="prompt-category"
                    value={categoryId}
                    disabled={saving}
                    onChange={(event) => setCategoryId(event.target.value)}
                  >
                    <option value="">未分类</option>
                    {categoryMissing && (
                      <option value={categoryId} disabled>
                        原分类已删除，请重新选择
                      </option>
                    )}
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="prompt-form-field">
                  <div className="prompt-content-label">
                    <Label>Markdown 正文</Label>
                    {template && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={working}
                        onClick={() => {
                          setName(template.name);
                          setDescription(template.description);
                          setContent(template.content);
                        }}
                      >
                        <RotateCcw size={13} />
                        恢复内置内容
                      </Button>
                    )}
                  </div>
                  <MarkdownEditor
                    ariaLabel="Markdown 正文"
                    value={content}
                    onChange={setContent}
                    readOnly={saving}
                    darkMode={isDarkMode}
                    minHeight="300px"
                  />
                </div>
                <p className="prompt-detail-note">
                  {initialData?.enabled
                    ? `正文变化时会更新 ${appName} 的全局指令；只改名称、描述或分类不会修改文件。`
                    : "保存只更新提示词库，不会自动启用或修改当前指令。"}
                  {template && " 恢复内置内容也需要保存后才会应用。"}
                </p>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={requestClose}>
              {readOnly ? "关闭" : "取消"}
            </Button>
            {readOnly ? (
              <>
                <Button
                  variant={initialData?.enabled ? "default" : "outline"}
                  disabled={working}
                  onClick={() => setReadOnly(false)}
                >
                  <Pencil size={14} />
                  编辑内容
                </Button>
                {!initialData?.enabled && (
                  <Button disabled={working} onClick={() => void onActivate()}>
                    {appName === "Codex" ? "启用此提示词" : "设为当前"}
                  </Button>
                )}
              </>
            ) : (
              <Button
                disabled={
                  !name.trim() || !content.trim() || working || categoryMissing
                }
                onClick={() => void handleSave()}
              >
                {saving
                  ? "正在保存…"
                  : initialData?.enabled && content !== initialData.content
                    ? "保存并应用"
                    : "保存"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        isOpen={discarding}
        title="放弃未保存的修改？"
        message="关闭后，这次修改不会保留，当前生效的指令不会改变。"
        confirmText="放弃修改"
        cancelText="继续编辑"
        onCancel={() => setDiscarding(false)}
        onConfirm={onClose}
      />
    </>
  );
};
export default PromptFormModal;
