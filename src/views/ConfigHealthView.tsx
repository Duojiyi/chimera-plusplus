import { isTauri } from "@tauri-apps/api/core";
import "./ConfigHealthView.css";
import "@/theme/v3/config-health.css";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { HelpCircle, RotateCw, Wrench } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";
import {
  configHealthApi,
  type ConfigHealthIssue,
  type ConfigHealthReport,
} from "@/lib/api/configHealth";
import {
  configHealthSampleReport,
  isConfigHealthDesignPreview,
} from "./ConfigHealthView.designSamples";

type Tone = "critical" | "warning" | "info";

// Every new install starts without these files. The backend still files them
// as warnings, but nothing is wrong yet: say what creates them instead.
const firstUseHints: Record<string, string> = {
  missing: "在「线路」页添加线路后会自动生成。",
  "auth-missing": "登录官方账号后会自动生成；使用环境变量认证时不需要。",
};
// Issue ids are "<code>-<index>".
const issueCode = (issue: ConfigHealthIssue) => issue.id.replace(/-\d+$/, "");
const toneOf = (issue: ConfigHealthIssue): Tone =>
  issue.severity === "warning" && Object.hasOwn(firstUseHints, issueCode(issue))
    ? "info"
    : issue.severity;

const groups: { tone: Tone; label: string }[] = [
  { tone: "critical", label: "需要处理" },
  { tone: "warning", label: "建议" },
  { tone: "info", label: "提示" },
];

/** "刚刚" / "N 分钟前" / "N 小时前", then the local date and time. */
const sinceChecked = (iso: string, now = Date.now()) => {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时前`;
  return new Date(at).toLocaleString();
};

// A parameter the backend could not place has no line: say so, never guess one.
const issueLocation = (issue: ConfigHealthIssue) =>
  issue.line !== undefined
    ? `${issue.location} · 第 ${issue.line} 行${
        issue.column !== undefined ? `，第 ${issue.column} 列` : ""
      }`
    : issue.field
      ? `${issue.location} · 未定义，无对应行`
      : issue.location;
const manualReason = (issue: ConfigHealthIssue) =>
  `这一项没有自动修复，请按修复建议手动修改 ${issue.location}。自动修复只清理 Chimera 自有的失效指令引用。`;

export const ConfigHealthView: React.FC = () => {
  const [report, setReport] = useState<ConfigHealthReport | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);
  // Updated only when a check settles, so the header does not flicker while
  // a recheck is running.
  const [repairOffered, setRepairOffered] = useState(false);
  const mutation = useRef(false);
  useLightweightCloseBlocker(repairing);
  const preview = !isTauri() && isConfigHealthDesignPreview();
  const handleRecheck = useCallback(async () => {
    if (!isTauri()) {
      // `?preview=design` shows a fixture so the layout can be reviewed in a
      // browser; nothing is read from disk and repair stays disabled.
      if (isConfigHealthDesignPreview()) {
        const sample = configHealthSampleReport();
        setReport(sample);
        setRepairOffered(Boolean(sample.repairToken));
      }
      setChecking(false);
      return;
    }
    const request = ++generation.current;
    setChecking(true);
    setError(false);
    setReport(null);
    try {
      const result = await configHealthApi.check();
      if (request === generation.current) {
        setReport(result);
        setRepairOffered(Boolean(result.repairToken));
      }
    } catch {
      if (request === generation.current) {
        setError(true);
        setRepairOffered(false);
      }
    } finally {
      if (request === generation.current) setChecking(false);
    }
  }, []);
  useEffect(() => {
    void handleRecheck();
    return () => {
      generation.current++;
    };
  }, [handleRecheck]);
  const repair = async () => {
    if (!confirmation || mutation.current) return;
    mutation.current = true;
    setRepairing(true);
    const request = ++generation.current;
    try {
      const result =
        await configHealthApi.repairOwnedInstructions(confirmation);
      if (request === generation.current) {
        setReport(result);
        setRepairOffered(Boolean(result.repairToken));
        setError(false);
      }
    } catch {
      if (request === generation.current) {
        toast.error("修复未确认完成，请重新检查后再试。");
        await handleRecheck();
      }
    } finally {
      mutation.current = false;
      setRepairing(false);
      setConfirmation(null);
    }
  };
  const items = report?.issues ?? [];
  const count = (tone: Tone) =>
    items.filter((item) => toneOf(item) === tone).length;
  const critical = count("critical");
  const warning = count("warning");
  const info = count("info");
  // The backend only issues a token when it found a repair it can perform.
  const repairToken = report?.repairToken ?? null;
  const canRepair =
    !preview &&
    repairToken !== null &&
    !checking &&
    !repairing &&
    confirmation === null;
  const headline = checking
    ? "正在检查…"
    : error
      ? "检查失败"
      : !report
        ? "尚无检查结果"
        : critical > 0
          ? `有 ${critical} 项需要处理`
          : warning > 0
            ? `有 ${warning} 项建议`
            : "一切正常";
  const detail = report
    ? [
        critical > 0 && warning > 0 ? `${warning} 条建议` : null,
        info > 0 ? `${info} 条提示` : null,
        "只读检测",
      ]
        .filter(Boolean)
        .join(" · ")
    : "尚无有效检测结果";

  const checkedNote = report ? sinceChecked(report.checkedAt) : "";
  // The one place the check time is shown; the exact time is on hover.
  const headerNote = checking ? (
    "正在检查…"
  ) : report ? (
    <time
      dateTime={report.checkedAt}
      title={new Date(report.checkedAt).toLocaleString()}
    >
      上次 {checkedNote}
    </time>
  ) : (
    "尚未检查"
  );
  const verdictTone =
    error || critical > 0 ? "bad" : warning > 0 ? "warn" : report ? "ok" : "";
  const subtitle = (
    <p>
      扫描 Codex 的 config.toml、auth.json 与引用文件 · 修复需单独确认 ·{" "}
      {headerNote}
    </p>
  );

  if (!isTauri() && !preview)
    return (
      <div className="connected-page config-health-page">
        <header className="health-header">
          <div>
            <h1>配置体检</h1>
            <p>
              扫描 Codex 的 config.toml、auth.json 与引用文件 · 修复需单独确认
            </p>
          </div>
        </header>
        <p role="status" className="health-message">
          浏览器预览未连接本机，无法检查配置。请在桌面应用中运行配置体检。
        </p>
      </div>
    );
  return (
    <div className="connected-page config-health-page">
      <header className="health-header">
        <div>
          <h1>配置体检</h1>
          {subtitle}
        </div>
        {/* The optional action comes first so it never moves 重新检查. */}
        <div className="health-actions">
          {repairOffered && (
            <Button
              variant="outline"
              size="sm"
              className="health-secondary"
              disabled={!canRepair}
              onClick={() => setConfirmation(repairToken)}
              title={
                preview
                  ? "设计示例不修改配置"
                  : "仅清理 Chimera 自有的失效指令引用，不改用户外部路径"
              }
            >
              <Wrench size={14} aria-hidden="true" />
              {repairing ? "正在修复…" : "修复自有引用"}
            </Button>
          )}
          <Button
            size="sm"
            className="health-primary"
            onClick={() => void handleRecheck()}
            disabled={preview || checking || repairing || confirmation !== null}
            title={preview ? "设计示例不读取本机配置" : undefined}
          >
            <RotateCw
              size={14}
              className={checking ? "spin" : undefined}
              aria-hidden="true"
            />
            重新检查
          </Button>
        </div>
      </header>

      <section className="health-summary" aria-label="体检结论">
        <dl className="health-stats">
          <div className="health-stat" data-tone={verdictTone || undefined}>
            <dt>结论</dt>
            <dd className="health-verdict" role="status">
              {headline}
            </dd>
          </div>
          <div
            className="health-stat"
            data-tone={report && critical > 0 ? "bad" : undefined}
          >
            <dt>需要处理</dt>
            <dd className="health-count">{report ? critical : "—"}</dd>
          </div>
          <div
            className="health-stat"
            data-tone={report && warning > 0 ? "warn" : undefined}
          >
            <dt>建议</dt>
            <dd className="health-count">{report ? warning : "—"}</dd>
          </div>
          <div className="health-stat">
            <dt>提示</dt>
            <dd className="health-count">{report ? info : "—"}</dd>
          </div>
        </dl>
        <div className="health-summary-foot">
          <span className="health-plate-detail">{detail}</span>
          <button
            aria-label="了解配置体检范围"
            type="button"
            className="health-plate-help"
            onClick={() =>
              toast.info(
                "检查配置结构、供应商与文件引用。不检测端口连通性、不修改配置、不回显密钥。",
              )
            }
          >
            <HelpCircle size={14} aria-hidden="true" />
          </button>
        </div>
      </section>

      {error && (
        <p className="health-message is-error" role="alert">
          配置体检失败，请点击「重新检查」重试。未显示旧结果。
        </p>
      )}

      {(report || checking) && (
        <section
          className="health-checks"
          aria-labelledby="health-checks-title"
        >
          <header className="health-checks-head">
            <h2 id="health-checks-title">检查项</h2>
            <p>
              {checking
                ? "正在读取本机配置…"
                : `按严重程度排序 · 共 ${items.length} 项发现`}
            </p>
          </header>
          {checking && !report && (
            <div className="health-skeleton" aria-hidden="true">
              {[0, 1, 2, 3].map((row) => (
                <span key={row} />
              ))}
            </div>
          )}
          {report && items.length === 0 && (
            <p className="health-message health-clean" role="status">
              本次已检查范围内未发现问题；这不代表所有运行时状态均正常。
            </p>
          )}
          {groups.map(({ tone, label }) => {
            const group = items.filter((item) => toneOf(item) === tone);
            if (group.length === 0) return null;
            return (
              <div
                key={tone}
                className="health-group"
                data-tone={tone}
                role="group"
                aria-labelledby={`health-group-${tone}`}
              >
                <h3 id={`health-group-${tone}`} className="health-group-title">
                  {label} · {group.length}
                </h3>
                <ul className="health-list">
                  {group.map((item) => (
                    <li key={item.id} className="health-item" data-tone={tone}>
                      <i className="health-item-dot" aria-hidden="true" />
                      <div className="health-item-body">
                        <p className="health-item-title">{item.title}</p>
                        {tone === "info" ? (
                          <p className="health-item-solution">
                            {firstUseHints[issueCode(item)]}
                          </p>
                        ) : (
                          item.impact && (
                            <p className="health-item-impact">{item.impact}</p>
                          )
                        )}
                        <p className="health-item-meta">
                          <span className="health-item-location">
                            {issueLocation(item)}
                          </span>
                          {item.field && (
                            <span className="health-item-field">
                              参数：<code>{item.field}</code>
                            </span>
                          )}
                        </p>
                        {tone !== "info" && item.solution && (
                          <p className="health-item-solution">
                            <span className="health-item-label">
                              修复建议：
                            </span>
                            {item.solution}
                          </p>
                        )}
                      </div>
                      {tone === "info" ? null : item.repairable &&
                        repairToken !== null ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="health-item-action"
                          disabled={!canRepair}
                          aria-label={`修复「${item.title}」`}
                          title="修复全部 Chimera 自有失效引用，需确认"
                          onClick={() => setConfirmation(repairToken)}
                        >
                          修复…
                        </Button>
                      ) : (
                        // Focusable so keyboard users can reach the reason.
                        <button
                          type="button"
                          className="health-manual"
                          aria-disabled="true"
                          aria-describedby={`${item.id}-manual`}
                          title={manualReason(item)}
                        >
                          需手动修复
                          <span id={`${item.id}-manual`} hidden>
                            {manualReason(item)}
                          </span>
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          <p className="health-footnote">
            体检只读取配置，不会修改任何文件。「修复自有引用」只清理 Chimera++
            自己目录里失效的指令引用，修改前先备份 config.toml。
          </p>
        </section>
      )}
      <ConfirmDialog
        isOpen={confirmation !== null}
        busy={repairing}
        title="修复自有指令引用"
        message="仅移除 Chimera 自有目录中缺失或空文件的指令引用。先备份 config.toml，不修改用户外部路径、模型选择或登录凭据；配置变化或代理接管中将拒绝修复。"
        checkboxLabel="我已了解修复范围并同意先备份后修改"
        checkboxRequired
        confirmText="备份并修复"
        cancelText="取消"
        onConfirm={() => void repair()}
        onCancel={() => setConfirmation(null)}
      />
    </div>
  );
};
