import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  officialAccountsApi,
  type OfficialAccountDto,
  type OfficialAccountGroup,
} from "@/lib/api/officialAccounts";

const NEW_GROUP = "__new__";

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Splits what the user typed into tags: commas, 、 or spaces separate them. */
export function parseTags(text: string): string[] {
  return text
    .split(/[,，、\s]+/)
    .map((tag) => tag.replace(/^#/, "").trim())
    .filter(Boolean);
}

/**
 * Note, tags, group and 停用 of one official account. Only what changed is
 * written; the backend enforces the limits and says which one was hit.
 */
export function AccountDetailsDialog({
  account,
  title,
  inUse = false,
  onClose,
  onSaved,
}: {
  account: OfficialAccountDto | null;
  title: string;
  /** Codex is using this account (or its line is selected): not held out. */
  inUse?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const id = useId();
  const [groups, setGroups] = useState<OfficialAccountGroup[]>([]);
  const [note, setNote] = useState("");
  const [tags, setTags] = useState("");
  const [group, setGroup] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const [disabled, setDisabled] = useState(false);
  const [saving, setSaving] = useState(false);
  // A group made by a save that then failed, so a retry does not make it twice.
  const [createdGroup, setCreatedGroup] = useState<{
    name: string;
    id: string;
  } | null>(null);
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState(false);

  useEffect(() => {
    if (!account) return;
    setNote(account.note ?? "");
    setTags((account.tags ?? []).join("，"));
    setGroup(account.groupId ?? "");
    setNewGroup("");
    setCreatedGroup(null);
    setConfirmDeleteGroup(false);
    setDisabled(Boolean(account.disabled));
    let alive = true;
    officialAccountsApi
      .listGroups()
      .then((list) => {
        if (alive) setGroups(list);
      })
      .catch(() => {
        if (alive) setGroups([]);
      });
    return () => {
      alive = false;
    };
  }, [account]);

  const save = async () => {
    if (!account) return;
    setSaving(true);
    try {
      const key = account.key;
      if (note.trim() !== (account.note ?? "").trim())
        await officialAccountsApi.setNote(key, note);
      const nextTags = parseTags(tags);
      if (nextTags.join("\n") !== (account.tags ?? []).join("\n"))
        await officialAccountsApi.setTags(key, nextTags);
      let groupId: string | null = group || null;
      if (group === NEW_GROUP) {
        const name = newGroup.trim();
        if (!name) groupId = null;
        else if (createdGroup?.name === name) groupId = createdGroup.id;
        else {
          groupId = (await officialAccountsApi.createGroup(name)).id;
          setCreatedGroup({ name, id: groupId });
        }
      }
      if (groupId !== (account.groupId ?? null))
        await officialAccountsApi.setGroup(key, groupId);
      if (disabled !== Boolean(account.disabled))
        await officialAccountsApi.setDisabled(key, disabled);
      toast.success("已保存账号信息");
      onSaved();
      onClose();
    } catch (cause) {
      toast.error("保存失败", { description: errorText(cause) });
      // Fields written before the failing one are saved: show them.
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const selectedGroup = groups.find((item) => item.id === group);
  const deleteGroup = async () => {
    if (!selectedGroup) return;
    setSaving(true);
    try {
      await officialAccountsApi.deleteGroup(selectedGroup.id);
      setGroups((list) => list.filter((item) => item.id !== selectedGroup.id));
      setGroup("");
      setConfirmDeleteGroup(false);
      toast.success(`已删除分组「${selectedGroup.name}」`);
      onSaved();
    } catch (cause) {
      toast.error("删除分组失败", { description: errorText(cause) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={account !== null}
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent
        className="account-dialog account-details-dialog"
        overlayClassName="backdrop-blur-none"
      >
        <DialogTitle>编辑「{title}」</DialogTitle>
        <DialogDescription className="account-dialog-description">
          备注、标签和分组只用于整理和筛选，不会改动登录。
        </DialogDescription>
        <form
          className="account-details-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label htmlFor={`${id}-note`}>备注</label>
          <Input
            id={`${id}-note`}
            value={note}
            maxLength={200}
            placeholder="例如：公司账号，周五续费"
            onChange={(event) => setNote(event.target.value)}
          />
          <label htmlFor={`${id}-tags`}>标签</label>
          <Input
            id={`${id}-tags`}
            value={tags}
            placeholder="用逗号或空格分隔，例如：主力，工作"
            onChange={(event) => setTags(event.target.value)}
          />
          <label htmlFor={`${id}-group`}>分组</label>
          <select
            id={`${id}-group`}
            className="account-details-select"
            value={group}
            onChange={(event) => {
              setGroup(event.target.value);
              setConfirmDeleteGroup(false);
            }}
          >
            <option value="">不分组</option>
            {groups.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}（{item.accountCount}）
              </option>
            ))}
            <option value={NEW_GROUP}>新建分组…</option>
          </select>
          {group === NEW_GROUP ? (
            <Input
              aria-label="新分组名称"
              value={newGroup}
              maxLength={40}
              placeholder="新分组名称"
              autoFocus
              onChange={(event) => setNewGroup(event.target.value)}
            />
          ) : null}
          {selectedGroup ? (
            <p className="account-details-group-actions">
              {confirmDeleteGroup ? (
                <>
                  <span>
                    删除分组「{selectedGroup.name}」？其中的{" "}
                    {selectedGroup.accountCount}{" "}
                    个账号变为不分组，账号本身不受影响。
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={saving}
                    onClick={() => void deleteGroup()}
                  >
                    删除分组
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => setConfirmDeleteGroup(false)}
                  >
                    取消
                  </Button>
                </>
              ) : (
                <button
                  type="button"
                  className="account-details-link"
                  disabled={saving}
                  onClick={() => setConfirmDeleteGroup(true)}
                >
                  删除这个分组…
                </button>
              )}
            </p>
          ) : null}
          <label className="account-details-check">
            <input
              type="checkbox"
              checked={disabled}
              disabled={inUse && !disabled}
              onChange={(event) => setDisabled(event.target.checked)}
            />
            <span>
              停用这个账号
              <small>
                {inUse && !disabled
                  ? "Codex 正在使用这个账号，先切换到别的账号再停用。"
                  : "停用后这个页面不再提供切换，也不读取额度；登录仍然保留。"}
              </small>
            </span>
          </label>
          <footer className="account-dialog-actions">
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={onClose}
            >
              取消
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "正在保存…" : "保存"}
            </Button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}
