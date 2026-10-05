import "./CcSwitchImportPreview.css";
import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ccSwitchImportApi,
  type CcSwitchImportAction,
  type CcSwitchImportInventory,
  type CcSwitchImportResult,
  type CcSwitchImportRow,
  type CcSwitchImportSelection,
  type CcSwitchImportStatus,
} from "@/lib/api/ccSwitchImport";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";
import {
  additionalToolNames,
  nativeToolNames,
} from "@/utils/toolProviderConfig";

const categories: Record<CcSwitchImportStatus, string> = {
  new: "新增",
  identical: "与现有相同",
  conflict: "冲突",
  unsupported: "不支持",
};

const toolNames: Record<string, string> = {
  codex: "Codex",
  ...nativeToolNames,
  ...additionalToolNames,
};

const conflictChoices: Array<[CcSwitchImportAction, string]> = [
  ["skip", "保留现有"],
  ["duplicate", "作为新线路"],
  ["replace", "覆盖"],
];

const untouched = "未写入任何线路";
// Each code is a refusal before any write. Anything else may have committed,
// so it gets a message that is safe to act on either way.
const commitFailures: Record<string, string> = {
  IMPORT_PREVIEW_EXPIRED: `预览已过期或已使用，${untouched}。请重新读取文件后再导入。`,
  IMPORT_SOURCE_CHANGED: `源文件在预览后有改动，${untouched}。请重新读取文件并核对。`,
  IMPORT_FILE_UNREADABLE: `无法再次读取源文件，${untouched}。请确认文件仍在原位置后重试。`,
  IMPORT_DATABASE_CHANGED: `本机线路在预览后有改动，${untouched}。请重新读取文件并核对。`,
  IMPORT_BACKUP_FAILED: `导入前备份失败，${untouched}。请检查磁盘空间和目录权限后重试。`,
  IMPORT_TARGET_PROTECTED: `所选线路受保护，不能覆盖，${untouched}。请重新读取文件并核对。`,
  INVALID_IMPORT_SELECTION: `所选内容与预览不一致，${untouched}。请重新读取文件并核对。`,
  IMPORT_COMMIT_UNAVAILABLE: `当前版本未开放导入写入，${untouched}。`,
};
const unknownFailure =
  "无法确认导入结果。请重新读取文件核对：已导入的线路会显示为“与现有相同”，不会重复导入。";

const rowKey = (row: CcSwitchImportRow) =>
  JSON.stringify([row.app, row.sourceId]);
const actionable = (row: CcSwitchImportRow) =>
  row.status === "new" || row.status === "conflict";
const writes = (action: CcSwitchImportAction | undefined) =>
  action !== undefined && action !== "skip";
// The design sample carries no flag; there a single match counts as replaceable.
const replaceable = (row: CcSwitchImportRow) =>
  row.replaceable ?? row.existingIds.length === 1;
const toolName = (app: string) => toolNames[app] ?? app;

function actionLabel(row: CcSwitchImportRow, action: CcSwitchImportAction) {
  if (action === "replace") return `覆盖现有线路 ${row.existingIds[0]}`;
  if (action === "duplicate") return "作为新线路，名称重复时加序号";
  return "新增";
}

function ImportOutcome({ result }: { result: CcSwitchImportResult }) {
  const written = result.imported + result.replaced;
  const counts = [
    [result.imported, "新增"],
    [result.replaced, "覆盖"],
    [result.skipped, "跳过"],
    [result.failed, "失败"],
  ] as const;
  const failed = result.rows.filter((row) => row.outcome === "failed");
  return (
    <div className="cc-switch-import-outcome" role="status">
      <strong>
        {written > 0 ? `已导入 ${written} 条线路` : "没有写入任何线路"}
      </strong>
      <p>
        {counts
          .filter(([count]) => count > 0)
          .map(([count, label]) => `${label} ${count} 条`)
          .join(" · ")}
      </p>
      <p>
        导入前备份：<code>{result.backupName}</code>
      </p>
      {result.sanitizedKeys.length > 0 && (
        <p>已移除不安全的配置项：{result.sanitizedKeys.join("、")}</p>
      )}
      {failed.length > 0 && (
        <ul>
          {failed.map((row) => (
            <li key={JSON.stringify([row.app, row.sourceId])}>
              {row.name}：{row.reason ?? "未写入"}
            </li>
          ))}
        </ul>
      )}
      {written > 0 && (
        <p>
          导入的线路均未启用，当前线路和各工具的配置文件保持不变，可在对应工具的线路列表中查看。
        </p>
      )}
    </div>
  );
}

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
  const [choices, setChoices] = useState<Record<string, CcSwitchImportAction>>(
    {},
  );
  const [step, setStep] = useState<"review" | "confirm">("review");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<CcSwitchImportResult | null>(null);
  const [failure, setFailure] = useState("");
  const pickerRef = useRef<HTMLButtonElement>(null);
  const lastPath = useRef<string | null>(null);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const dialogRef = useDialogFocus<HTMLDivElement>(
    () => {
      if (inFlight.current) return;
      if (step === "confirm") setStep("review");
      else setInventory(null);
    },
    Boolean(inventory),
    pickerRef,
  );
  const selectedRows =
    inventory?.rows.filter((row) => writes(choices[rowKey(row)])) ?? [];
  const replacing = selectedRows.filter(
    (row) => choices[rowKey(row)] === "replace",
  ).length;
  const adding = selectedRows.length - replacing;
  const removedKeys = [
    ...new Set(selectedRows.flatMap((row) => row.sanitizedKeys ?? [])),
  ];
  const canCommit =
    native &&
    !exampleMode &&
    inventory?.canCommit === true &&
    !inventory.writesLive &&
    Boolean(inventory.previewId);
  useLightweightCloseBlocker(busy || Boolean(inventory));
  useEffect(() => {
    generation.current++;
    setInventory(null);
    setError(false);
    setResult(null);
    setFailure("");
    setStep("review");
    setCommitting(false);
    setBusy(false);
    inFlight.current = false;
    return () => {
      generation.current++;
    };
  }, [native]);
  useEffect(() => {
    // Each step opens on its least consequential action.
    if (inventory)
      dialogRef.current
        ?.querySelector<HTMLElement>("[data-autofocus]")
        ?.focus();
  }, [dialogRef, inventory, step]);

  const choose = (row: CcSwitchImportRow, action: CcSwitchImportAction) =>
    setChoices((previous) => ({ ...previous, [rowKey(row)]: action }));

  async function readPreview(sameFile: boolean) {
    if ((!native && !exampleMode) || inFlight.current) return;
    inFlight.current = true;
    const token = generation.current;
    setBusy(true);
    setError(false);
    setResult(null);
    setFailure("");
    setInventory(null);
    try {
      let next: CcSwitchImportInventory;
      if (exampleMode) {
        next = (await import("@/data/ccSwitchDesignInventory"))
          .CC_SWITCH_DESIGN_INVENTORY;
      } else {
        const path =
          sameFile && lastPath.current
            ? lastPath.current
            : await open({
                multiple: false,
                directory: false,
                filters: [
                  { name: "cc-switch config.json", extensions: ["json"] },
                ],
              });
        if (generation.current !== token || typeof path !== "string") return;
        lastPath.current = path;
        next = await ccSwitchImportApi.preview(path);
      }
      if (generation.current === token) {
        setChoices(
          Object.fromEntries(
            next.rows
              .filter(actionable)
              .map((row): [string, CcSwitchImportAction] => [
                rowKey(row),
                row.status === "new" ? "import" : "skip",
              ]),
          ),
        );
        setStep("review");
        setInventory(next);
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
      selectedRows.length === 0 ||
      inFlight.current
    )
      return;
    inFlight.current = true;
    const token = generation.current;
    setBusy(true);
    setCommitting(true);
    // Every reviewed row carries an explicit decision, including "keep".
    const selections = inventory.rows
      .filter(actionable)
      .map((row): CcSwitchImportSelection => ({
        app: row.app,
        sourceId: row.sourceId,
        action: choices[rowKey(row)] ?? "skip",
      }));
    try {
      const outcome = await ccSwitchImportApi.commit(
        inventory.previewId,
        selections,
      );
      if (generation.current === token) setResult(outcome);
    } catch (cause) {
      if (generation.current === token)
        setFailure(
          (typeof cause === "string" && commitFailures[cause]) ||
            unknownFailure,
        );
    } finally {
      if (generation.current === token) {
        inFlight.current = false;
        setBusy(false);
        setCommitting(false);
        setStep("review");
        // The preview is used up either way. Refresh even after a transport
        // failure: the transaction may have committed.
        setInventory(null);
        onImported?.();
      }
    }
  }

  const plan = [
    adding > 0 ? `新增 ${adding} 条线路` : "",
    replacing > 0 ? `覆盖 ${replacing} 条现有线路` : "",
  ]
    .filter(Boolean)
    .join("，");
  const summary = `将${plan}，不会切换当前线路，不会改写任何工具的配置文件。导入前会自动备份数据库。`;

  return (
    <section
      className="settings-import-file-note"
      aria-labelledby="cc-switch-preview-heading"
    >
      <h3 id="cc-switch-preview-heading">从 cc-switch 文件导入</h3>
      <p>
        选择 cc-switch 的 config.json，逐条核对后导入线路。只导入线路，不导入
        MCP 和提示词，也不执行脚本；导入的线路不会自动启用。
      </p>
      <button
        type="button"
        className="secondary"
        ref={pickerRef}
        disabled={(!native && !exampleMode) || busy}
        onClick={() => void readPreview(false)}
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
      {failure && (
        <div className="cc-switch-import-outcome is-failed">
          <p role="alert">{failure}</p>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void readPreview(true)}
          >
            重新读取文件
          </button>
        </div>
      )}
      {result && <ImportOutcome result={result} />}
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
            {step === "review" ? (
              <>
                <h2 id="cc-switch-confirm-title">从 cc-switch 导入线路？</h2>
                {exampleMode && (
                  <p className="settings-tools-preview-note">
                    设计样例 · 非本机数据 · 不读取或写入文件
                  </p>
                )}
                <p id="cc-switch-confirm-description" role="status">
                  共 {inventory.rows.length} 条，已选择 {selectedRows.length}{" "}
                  条。新增默认选中，冲突默认保留现有；导入的线路不会自动启用。
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
                                    checked={choices[rowKey(row)] === "import"}
                                    onChange={(event) =>
                                      choose(
                                        row,
                                        event.target.checked
                                          ? "import"
                                          : "skip",
                                      )
                                    }
                                  />
                                  <strong>{row.name}</strong>
                                </label>
                              ) : (
                                <strong>{row.name}</strong>
                              )}
                              <span>
                                {toolName(row.app)} · {row.reason}
                              </span>
                              {status === "conflict" && (
                                <fieldset className="cc-switch-conflict-choice">
                                  <legend className="sr-only">
                                    {row.name}的冲突处理
                                  </legend>
                                  {conflictChoices.map(([action, text]) => (
                                    <label key={action}>
                                      <input
                                        type="radio"
                                        name={rowKey(row)}
                                        checked={
                                          (choices[rowKey(row)] ?? "skip") ===
                                          action
                                        }
                                        disabled={
                                          action === "replace" &&
                                          !replaceable(row)
                                        }
                                        onChange={() => choose(row, action)}
                                      />
                                      {text}
                                    </label>
                                  ))}
                                  {!replaceable(row) &&
                                    row.existingIds.length > 0 && (
                                      <small>
                                        {row.existingIds.length > 1
                                          ? "匹配到多条现有线路，无法确定覆盖哪一条。"
                                          : "现有线路正在使用或受保护，不能覆盖。"}
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
                  <dd>仅所选线路，保存到本机线路列表，不启用</dd>
                  <dt>导入前</dt>
                  <dd>自动备份数据库；备份失败不写入，任何一步出错全部撤销</dd>
                  <dt>不改动</dt>
                  <dd>源文件、当前线路、各工具的配置文件、MCP 和提示词</dd>
                </dl>
                {!canCommit && (
                  <p className="cc-switch-import-note">
                    {exampleMode
                      ? "设计样例仅供查看，不能导入。"
                      : "当前版本未开放导入写入，只能核对。"}
                  </p>
                )}
                <footer>
                  <button
                    type="button"
                    className="primary"
                    disabled={!canCommit || selectedRows.length === 0}
                    onClick={() => setStep("confirm")}
                  >
                    导入所选 {selectedRows.length} 条
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    data-autofocus
                    onClick={() => setInventory(null)}
                  >
                    取消
                  </button>
                </footer>
              </>
            ) : (
              <>
                <h2 id="cc-switch-confirm-title">确认导入</h2>
                <p id="cc-switch-confirm-description">{summary}</p>
                <ul className="cc-switch-import-plan" aria-label="将写入的线路">
                  {selectedRows.map((row) => (
                    <li key={rowKey(row)}>
                      <strong>{row.name}</strong>
                      <span>
                        {toolName(row.app)} ·{" "}
                        {actionLabel(row, choices[rowKey(row)])}
                      </span>
                    </li>
                  ))}
                </ul>
                {removedKeys.length > 0 && (
                  <p className="cc-switch-import-note">
                    导入时会移除不安全的配置项：{removedKeys.join("、")}
                  </p>
                )}
                {committing && (
                  <p className="cc-switch-import-note" role="status">
                    正在备份数据库并写入线路…
                  </p>
                )}
                <footer>
                  <button
                    type="button"
                    className="primary"
                    disabled={committing}
                    onClick={() => void commit()}
                  >
                    {committing ? "正在备份并导入…" : "确认导入"}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    data-autofocus
                    disabled={committing}
                    onClick={() => setStep("review")}
                  >
                    返回修改
                  </button>
                </footer>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
