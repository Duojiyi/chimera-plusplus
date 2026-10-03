import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";
import { settingsApi, type CodexImportReview } from "@/lib/api/settings";
import { SyncConfigForm } from "./SyncConfigForm";
import type { Settings } from "@/types";

type Backend = "webdav" | "s3";
type Action = { backend: Backend; kind: "upload" | "download" };

export function SyncPanel({
  settings,
  onRefresh,
  onBusyChange,
}: {
  settings: Settings | null;
  onRefresh: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const client = useQueryClient();
  const lock = useRef(false);
  const [editing, setEditing] = useState<Backend | null>(null);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [review, setReview] = useState<CodexImportReview | null>(null);
  const [reviewPending, setReviewPending] = useState(false);
  useLightweightCloseBlocker(busy);

  const refresh = async () => {
    // Attempt both paths even if one fails. Neither contacts the sync server.
    const results = await Promise.allSettled([
      client.invalidateQueries(),
      onRefresh(),
    ]);
    if (results.some((result) => result.status === "rejected")) {
      throw new Error("refresh failed");
    }
  };
  const readReview = async () => {
    setReviewPending(true);
    const pending = await settingsApi.getCodexImportReview();
    setReview(pending);
    setReviewPending(false);
  };
  const run = async (job: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    setNotice("");
    try {
      await job();
    } catch {
      // Backend errors may contain URLs, passwords or access keys. Never echo/log them.
      setError(
        "操作未完整完成，请检查配置。若已下载，请先重试审核与刷新，勿重复覆盖。",
      );
    } finally {
      lock.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  };
  const transfer = async (selected: Action) => {
    setAction(null);
    const api =
      selected.backend === "webdav"
        ? {
            info: settingsApi.webdavSyncFetchRemoteInfo,
            upload: settingsApi.webdavSyncUpload,
            download: settingsApi.webdavSyncDownload,
          }
        : {
            info: settingsApi.s3SyncFetchRemoteInfo,
            upload: settingsApi.s3SyncUpload,
            download: settingsApi.s3SyncDownload,
          };
    if (selected.kind === "download") {
      const info = await api.info();
      if ("empty" in info || !info.compatible) {
        setError("远端没有可下载的兼容快照，未执行下载。");
        return;
      }
      const result = await api.download();
      setNotice(
        result.warning
          ? "下载已完成，但工具配置同步有警告。请审核并检查工具状态。"
          : "下载已完成。请检查导入审核结果。",
      );
      // Refresh is still required when fetching the review fails.
      try {
        await readReview();
      } finally {
        await refresh();
      }
    } else {
      await api.upload();
      setNotice("手动上传已完成。");
    }
  };

  return (
    <section aria-label="手动云同步">
      <h3>WebDAV / S3 手动同步</h3>
      <p>
        先保存配置，再手动上传或下载。不会启动后台同步；所有远端操作均需点击。上传可能包含敏感配置，请仅使用可信存储。
      </p>
      {(["webdav", "s3"] as const).map((backend) => {
        const config =
          backend === "webdav" ? settings?.webdavSync : settings?.s3Sync;
        const label = backend === "webdav" ? "WebDAV" : "S3";
        const configured =
          !!config &&
          config.enabled !== false &&
          (backend === "webdav"
            ? !!settings?.webdavSync?.baseUrl?.trim()
            : settings?.s3Sync?.enabled === true &&
              !!settings.s3Sync.bucket?.trim());
        return (
          <fieldset key={backend} disabled={busy}>
            <legend>{label}</legend>
            <button
              className="secondary"
              disabled={busy || !!editing}
              onClick={() => setEditing(backend)}
            >
              配置 {label}
            </button>
            {!configured && <p>尚无已启用的 {label} 配置，手动入口不可用。</p>}
            {config?.autoSync && (
              <>
                <p>已有配置标记了自动同步，须先关闭自动项才能在此手动操作。</p>
                <button
                  className="secondary"
                  onClick={() =>
                    void run(async () => {
                      const result =
                        backend === "webdav"
                          ? await settingsApi.webdavSyncSaveSettings(
                              { ...settings?.webdavSync, autoSync: false },
                              false,
                            )
                          : await settingsApi.s3SyncSaveSettings(
                              { ...settings?.s3Sync, autoSync: false },
                              false,
                            );
                      if (!result.success) throw new Error("save failed");
                      await refresh();
                      setNotice("自动同步已关闭，未发起连接测试或同步。");
                    })
                  }
                >
                  关闭 {label} 自动同步
                </button>
              </>
            )}
            <button
              className="secondary"
              disabled={
                busy ||
                !!editing ||
                !configured ||
                !!config?.autoSync ||
                reviewPending ||
                !!review
              }
              onClick={() => {
                if (!lock.current) setAction({ backend, kind: "upload" });
              }}
            >
              {label} 手动上传
            </button>
            <button
              className="secondary"
              disabled={
                busy ||
                !!editing ||
                !configured ||
                !!config?.autoSync ||
                reviewPending ||
                !!review
              }
              onClick={() => {
                if (!lock.current) setAction({ backend, kind: "download" });
              }}
            >
              {label} 下载并覆盖
            </button>
          </fieldset>
        );
      })}
      {editing && (
        <SyncConfigForm
          key={editing}
          backend={editing}
          settings={settings}
          busy={busy}
          onCancel={() => {
            if (!lock.current) setEditing(null);
          }}
          onSave={(values, secretTouched) =>
            void run(async () => {
              const manualConfig = {
                ...values,
                enabled: true,
                autoSync: false,
              };
              const result =
                editing === "webdav"
                  ? await settingsApi.webdavSyncSaveSettings(
                      manualConfig,
                      secretTouched,
                    )
                  : await settingsApi.s3SyncSaveSettings(
                      manualConfig,
                      secretTouched,
                    );
              if (!result.success) throw new Error("save failed");
              setNotice("配置已保存；正在重新读取本地状态，未测试连接。");
              await onRefresh();
              setEditing(null);
              setNotice(
                "配置已保存并重新读取，可手动同步；自动同步关闭，未测试连接。",
              );
            })
          }
        />
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {reviewPending && (
        <p role="alert">导入审核尚未读取成功，未确认同步到 Codex。</p>
      )}
      {review && (
        <div aria-label="导入审核">
          <h4>导入配置待审核</h4>
          <p>
            以下仅列出被移除及待确认的设置名称。确认后才应用待审核的 Codex
            配置。
          </p>
          {[
            ...review.providers,
            ...(review.commonConfig ? [review.commonConfig] : []),
          ].map((report, index) => (
            <p key={index}>
              配置 {index + 1}：已移除 {report.stripped.join(", ") || "无"}
              ；待确认 {report.needsConfirmation.join(", ") || "无"}
            </p>
          ))}
          <button
            className="secondary"
            disabled={busy || reviewPending}
            onClick={() =>
              void run(async () => {
                await settingsApi.confirmCodexImportSync();
                setReview(null);
                setNotice("导入审核已确认。");
                await refresh();
              })
            }
          >
            确认审核并同步 Codex
          </button>
        </div>
      )}
      <button
        className="secondary"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            try {
              await readReview();
            } finally {
              await refresh();
            }
            setNotice("审核与本地数据已刷新。");
          })
        }
      >
        重试审核与刷新
      </button>
      <ConfirmDialog
        isOpen={!!action}
        busy={busy}
        title="确认手动同步"
        message={
          action?.kind === "download"
            ? "下载将覆盖当前应用数据库，并可能更新工具配置。请先创建本地备份并停止其他配置写入；导入后的待审核配置需要另行确认。"
            : "上传会向已配置的远端发送本地数据，可能覆盖远端快照并包含敏感配置。确认该存储可信且允许覆盖？冲突时不会强制上传。"
        }
        confirmText="确认执行"
        cancelText="取消"
        onCancel={() => {
          if (!lock.current) setAction(null);
        }}
        onConfirm={() => {
          if (action) void run(() => transfer(action));
        }}
      />
    </section>
  );
}
