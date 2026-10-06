import { useState } from "react";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import type { PromptCategory } from "@/lib/api/prompts";

export default function PromptCategoryManager({
  categories,
  counts,
  blocked,
  onCreate,
  onRename,
  onDelete,
  onClose,
}: {
  categories: PromptCategory[];
  counts: Record<string, number>;
  blocked: boolean;
  onCreate: (name: string) => Promise<boolean>;
  onRename: (id: string, name: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [removing, setRemoving] = useState<PromptCategory | null>(null);
  const [working, setWorking] = useState(false);
  const disabled = blocked || working;
  const invalid = (value: string, id?: string) =>
    !value.trim() ||
    Array.from(value.trim()).length > 50 ||
    ["全部", "全部分类", "未分类"].includes(value.trim()) ||
    categories.some(
      (category) =>
        category.id !== id &&
        category.name.toLocaleLowerCase() === value.trim().toLocaleLowerCase(),
    );
  const run = async (action: () => Promise<boolean>, success: () => void) => {
    if (disabled) return;
    setWorking(true);
    try {
      if (await action()) success();
    } finally {
      setWorking(false);
    }
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(value) => {
          if (!value && !working && !removing) onClose();
        }}
      >
        <DialogContent className="prompt-category-manager">
          <DialogHeader className="text-left">
            <div className="prompt-drawer-title">
              <DialogTitle>管理分类</DialogTitle>
              <Button
                variant="ghost"
                size="icon"
                aria-label="关闭分类管理"
                disabled={working}
                onClick={onClose}
              >
                <X size={18} />
              </Button>
            </div>
            <DialogDescription>
              分类仅用于当前工具的提示词整理，不影响启用状态。名称限 50
              字，不能重复。
            </DialogDescription>
          </DialogHeader>
          <form
            className="prompt-category-create"
            onSubmit={(event) => {
              event.preventDefault();
              if (!invalid(newName))
                void run(
                  () => onCreate(newName.trim()),
                  () => setNewName(""),
                );
            }}
          >
            <Input
              aria-label="新分类名称"
              placeholder="例如：日常办公"
              value={newName}
              maxLength={50}
              disabled={disabled}
              onChange={(event) => setNewName(event.target.value)}
            />
            <Button type="submit" disabled={disabled || invalid(newName)}>
              <Plus size={15} />
              新增
            </Button>
          </form>
          <ul className="prompt-category-list" aria-label="已有分类">
            {categories.map((category) => (
              <li key={category.id}>
                {editing === category.id ? (
                  <form
                    className="prompt-category-edit"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!invalid(name, category.id))
                        void run(
                          () => onRename(category.id, name.trim()),
                          () => setEditing(null),
                        );
                    }}
                  >
                    <Input
                      autoFocus
                      aria-label="分类新名称"
                      value={name}
                      maxLength={50}
                      disabled={disabled}
                      onChange={(event) => setName(event.target.value)}
                    />
                    <Button
                      type="submit"
                      size="sm"
                      disabled={disabled || invalid(name, category.id)}
                    >
                      保存分类
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      onClick={() => setEditing(null)}
                    >
                      取消
                    </Button>
                  </form>
                ) : (
                  <>
                    <span
                      className="prompt-category-name"
                      title={category.name}
                    >
                      {category.name}
                    </span>
                    <span className="prompt-category-count">
                      {counts[category.id] ?? 0} 条
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`重命名 ${category.name}`}
                      disabled={disabled}
                      onClick={() => {
                        setEditing(category.id);
                        setName(category.name);
                      }}
                    >
                      <Pencil size={15} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`删除分类 ${category.name}`}
                      disabled={disabled}
                      onClick={() => setRemoving(category)}
                    >
                      <Trash2 size={15} />
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {categories.length === 0 && (
            <p className="prompt-detail-note">
              还没有分类，新建一个来整理提示词。
            </p>
          )}
          <p className="prompt-detail-note">
            未分类是默认归属。删除分类后，其中的提示词会移到未分类，内容与启用状态保持不变。
          </p>
          <DialogFooter>
            <Button variant="outline" disabled={working} onClick={onClose}>
              完成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        isOpen={removing !== null}
        title="删除分类？"
        message={`「${removing?.name ?? ""}」中的提示词将移到未分类，不会删除提示词或修改生效文件。`}
        confirmText="删除分类"
        cancelText="取消"
        busy={working}
        onCancel={() => {
          if (!working) setRemoving(null);
        }}
        onConfirm={() => {
          if (removing)
            void run(
              () => onDelete(removing.id),
              () => setRemoving(null),
            );
        }}
      />
    </>
  );
}
