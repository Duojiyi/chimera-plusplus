import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ccSwitchImportApi,
  type CcSwitchImportInventory,
  type CcSwitchImportStatus,
} from "@/lib/api/ccSwitchImport";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";

const categories: Record<CcSwitchImportStatus, string> = {
  new: "新增",
  identical: "与现有相同",
  conflict: "冲突",
  unsupported: "不支持",
};

export function CcSwitchImportPreview({
  native,
  onImported,
}: {
  native: boolean;
  onImported?: () => void;
}) {
  const exampleMode =
    import.meta.env.DEV &&
    !native &&
    new URLSearchParams(window.location.search).get("preview") === "design";
  const [inventory, setInventory] = useState<CcSwitchImportInventory | null>(
    null,
  );
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const pickerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>(
    () => {
      if (!inFlight.current) setInventory(null);
    },
    Boolean(inventory),
    pickerRef,
  );
  const rowKey = (row: CcSwitchImportInventory["rows"][number]) =>
    JSON.stringify([row.app, row.sourceId]);
  const selected =
    inventory?.rows.filter((row) => choices[rowKey(row)]).length ?? 0;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitFailed, setCommitFailed] = useState(false);
  const canCommit =
    native &&
    !exampleMode &&
    inventory?.canCommit === true &&
    !inventory.writesLive &&
    Boolean(inventory.previewId);
  const inFlight = useRef(false);
  const generation = useRef(0);
  useLightweightCloseBlocker(busy || Boolean(inventory));
  useEffect(() => {
    generation.current++;
    setInventory(null);
    setError(false);
    setCommitMessage("");
    setCommitting(false);
    setBusy(false);
    inFlight.current = false;
    return () => {
      generation.current++;
    };
  }, [native]);

  async function chooseFile() {
    if ((!native && !exampleMode) || inFlight.current) return;
    inFlight.current = true;
    const token = generation.current;
    setBusy(true);
    setError(false);
    setCommitMessage("");
    setInventory(null);
    try {
      let result: CcSwitchImportInventory;
      if (exampleMode) {
        result = (await import("@/data/ccSwitchDesignInventory"))
          .CC_SWITCH_DESIGN_INVENTORY;
      } else {
        const path = await open({
          multiple: false,
          directory: false,
          filters: [{ name: "cc-switch config.json", extensions: ["json"] }],
        });
        if (generation.current !== token || typeof path !== "string") return;
        result = await ccSwitchImportApi.preview(path);
      }
      if (generation.current === token) {
        setChoices(
          Object.fromEntries(
            result.rows.map((row) => [rowKey(row), row.status === "new"]),
          ),
        );
        setInventory(result);
      }
    } catch {
      if (generation.current === token) setError(true);
    } finally {
      if (generation.current === token) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }

  async function commit() {
    if (
      !canCommit ||
      !inventory?.previewId ||
      selected === 0 ||
      inFlight.current
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setCommitting(true);
    setCommitMessage("");
    setCommitFailed(false);
    const token = generation.current;
    const selections = inventory.rows
      .filter(
        (row) =>
          choices[rowKey(row)] &&
          (row.status === "new" ||
            (row.status === "conflict" && row.existingIds.length === 1)),
      )
      .map((row) => ({
        app: row.app,
        sourceId: row.sourceId,
        ...(row.status === "conflict" ? { replaceId: row.existingIds[0] } : {}),
      }));
    try {
      const result = await ccSwitchImportApi.commit(
        inventory.previewId,
        selections,
      );
      if (generation.current !== token) return;
      setInventory(null);
      setCommitMessage(
        `已导入 ${result.imported} 条线路；备份：${result.backupId}。未启用线路，未改动实时配置。`,
      );
    } catch (cause) {
      if (generation.current !== token) return;
      setInventory(null);
      setCommitFailed(true);
      const messages: Record<string, string> = {
        IMPORT_PREVIEW_EXPIRED: "预览已过期或已使用，请重新选择文件并核对。",
        IMPORT_SOURCE_CHANGED: "源文件已变化，请重新预览后确认。",
        IMPORT_DATABASE_CHANGED: "本机线路已变化，请重新预览后确认。",
        IMPORT_TARGET_ACTIVE:
          "不能覆盖正在使用的线路，请先切换到其他线路并重新预览。",
        IMPORT_TARGET_PROTECTED:
          "所选线路受保护，不能覆盖，请重新预览并保留现有。",
        IMPORT_BACKUP_FAILED:
          "未能完成导入前备份，未写入线路。请检查存储空间和目录权限后重新预览。",
        IMPORT_COMMIT_UNAVAILABLE:
          "当前版本尚未开放导入写入，请等待原生验证通过。",
      };
      setCommitMessage(
        (typeof cause === "string" && messages[cause]) ||
          "无法确认导入结果，请重新读取线路并预览，不要重复提交旧预览。",
      );
    } finally {
      if (generation.current === token) {
        inFlight.current = false;
        setBusy(false);
        setCommitting(false);
        // Refresh even after a transport failure: the transaction may have committed.
        onImported?.();
      }
    }
  }

  return (
    <section
      className="settings-import-file-note"
      aria-labelledby="cc-switch-preview-heading"
    >
      <h3 id="cc-switch-preview-heading">从 cc-switch 文件导入</h3>
      <p>
        选择
        config.json，按新增、相同、冲突、不支持逐条核对。只核对供应商，不导入
        MCP、提示词，也不执行脚本。
      </p>
      <button
        type="button"
        className="secondary"
        ref={pickerRef}
        disabled={(!native && !exampleMode) || busy}
        onClick={() => void chooseFile()}
      >
        {committing
          ? "正在导入…"
          : busy
            ? "正在读取…"
            : exampleMode
              ? "查看导入设计示例"
              : "选择文件并预览"}
      </button>
      {error && (
        <p role="alert">
          无法读取供应商配置。请选择有效的 cc-switch config.json（不超过 8
          MB、1000 条），不支持数据库或 SQL 备份。
        </p>
      )}
      {commitMessage && (
        <p role={commitFailed ? "alert" : "status"}>{commitMessage}</p>
      )}
      {inventory && (
        <div className="modal-backdrop">
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="cc-switch-confirm-title"
            aria-describedby="cc-switch-confirm-description"
            tabIndex={-1}
            className="cc-switch-confirm-dialog"
          >
            <h2 id="cc-switch-confirm-title">从 cc-switch 导入线路？</h2>
            {exampleMode && (
              <p className="settings-tools-preview-note">
                设计样例 · 非本机数据 · 不读取或写入文件
              </p>
            )}
            <p id="cc-switch-confirm-description" role="status">
              共 {inventory.rows.length} 条，已选择 {selected}{" "}
              条。新增默认选中，冲突默认保留现有；尚未导入，不会启用线路。
            </p>
            <div className="settings-import-inventory">
              {(
                Object.entries(categories) as Array<
                  [CcSwitchImportStatus, string]
                >
              ).map(([status, label]) => {
                const rows = inventory.rows.filter(
                  (row) => row.status === status,
                );
                return (
                  <section key={status} aria-label={label}>
                    <h4>
                      {label} · {rows.length}
                    </h4>
                    {status === "identical" ? (
                      <div className="cc-switch-identical-summary">
                        <span>
                          {rows.map((row) => row.name).join("、") || "无"}
                        </span>
                        <small>自动跳过，不重复导入</small>
                      </div>
                    ) : (
                      rows.map((row) => (
                        <div
                          className={`settings-import-inventory-row cc-switch-row-${status}`}
                          key={rowKey(row)}
                        >
                          {status === "new" ? (
                            <label className="cc-switch-row-choice">
                              <input
                                type="checkbox"
                                disabled={committing}
                                checked={Boolean(choices[rowKey(row)])}
                                onChange={(event) =>
                                  setChoices((previous) => ({
                                    ...previous,
                                    [rowKey(row)]: event.target.checked,
                                  }))
                                }
                              />
                              <strong>{row.name}</strong>
                            </label>
                          ) : (
                            <strong>{row.name}</strong>
                          )}
                          <span>
                            {row.app} · {row.reason}
                          </span>
                          {status === "conflict" && (
                            <fieldset className="cc-switch-conflict-choice">
                              <legend className="sr-only">
                                {row.name}的冲突处理
                              </legend>
                              <label>
                                <input
                                  type="radio"
                                  name={rowKey(row)}
                                  disabled={committing}
                                  checked={!choices[rowKey(row)]}
                                  onChange={() =>
                                    setChoices((previous) => ({
                                      ...previous,
                                      [rowKey(row)]: false,
                                    }))
                                  }
                                />
                                保留现有
                              </label>
                              <label>
                                <input
                                  type="radio"
                                  name={rowKey(row)}
                                  checked={Boolean(choices[rowKey(row)])}
                                  disabled={
                                    committing || row.existingIds.length !== 1
                                  }
                                  onChange={() =>
                                    setChoices((previous) => ({
                                      ...previous,
                                      [rowKey(row)]: true,
                                    }))
                                  }
                                />
                                覆盖
                              </label>
                              {row.existingIds.length !== 1 && (
                                <small>
                                  无法唯一确定替换对象，请先处理重名线路。
                                </small>
                              )}
                            </fieldset>
                          )}
                          {status === "conflict" &&
                            row.existingIds.length > 0 && (
                              <small>
                                现有线路标识：{row.existingIds.join("、")}
                              </small>
                            )}
                        </div>
                      ))
                    )}
                  </section>
                );
              })}
            </div>
            <dl className="cc-switch-import-scope">
              <dt>写入</dt>
              <dd>仅所选供应商，目标为本机线路数据库</dd>
              <dt>导入前</dt>
              <dd>必须先创建备份；备份失败不写入，整批事务失败回滚</dd>
              <dt>不改动</dt>
              <dd>源文件、config.toml、当前启用线路、MCP 和提示词</dd>
            </dl>
            <footer>
              <button
                type="button"
                className="secondary"
                disabled={!canCommit || selected === 0 || committing}
                title={
                  canCommit
                    ? "仅导入所选线路，不自动启用"
                    : "需原生验证后开放导入写入"
                }
                onClick={() => void commit()}
              >
                {committing
                  ? "正在备份并导入…"
                  : canCommit
                    ? `确认导入 ${selected} 条`
                    : "确认导入（需桌面服务）"}
              </button>
              <button
                type="button"
                className="secondary"
                data-autofocus
                disabled={committing}
                onClick={() => setInventory(null)}
              >
                取消
              </button>
            </footer>
          </div>
        </div>
      )}
      <p>可逐项核对选择；导入由桌面后端完成，失败时不会用样例结果替代。</p>
    </section>
  );
}
