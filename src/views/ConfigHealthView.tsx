import "./ConfigHealthView.css";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  HelpCircle,
  Info,
  RotateCw,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";
import {
  configHealthApi,
  type ConfigHealthIssue,
  type ConfigHealthReport,
} from "@/lib/api/configHealth";

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

const groups: { tone: Tone; label: string; Icon: LucideIcon }[] = [
  { tone: "critical", label: "需要处理", Icon: XCircle },
  { tone: "warning", label: "建议", Icon: AlertTriangle },
  { tone: "info", label: "提示", Icon: Info },
];

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
  const handleRecheck = useCallback(async () => {
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
    repairToken !== null && !checking && !repairing && confirmation === null;
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

  return (
    <div className="connected-page config-health-page">
      <header className="health-header">
        <div>
          <h1>配置体检</h1>
          <p>检查 config.toml、auth.json 与引用文件 · 修复需单独确认</p>
        </div>
        {/* The optional action comes first so it never moves 重新检查. */}
        <div className="health-actions">
          {repairOffered && (
            <Button
              size="sm"
              disabled={!canRepair}
              onClick={() => setConfirmation(repairToken)}
              title="仅清理 Chimera 自有的失效指令引用，不改用户外部路径"
            >
              <Wrench size={16} aria-hidden="true" />
              {repairing ? "正在修复…" : "修复自有引用"}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleRecheck()}
            disabled={checking || repairing || confirmation !== null}
          >
            <RotateCw
              size={16}
              className={checking ? "spin" : undefined}
              aria-hidden="true"
            />
            重新检查
          </Button>
        </div>
      </header>

      {/* Summary plate: the dark graphite lightbox of the design. */}
      <div className="health-plate">
        <div className="health-plate-summary">
          <p className="health-plate-label">
            {checking
              ? "正在检查本地配置"
              : report
                ? "本次检查已完成"
                : "尚无检查结果"}
          </p>
          <p className="health-plate-title" role="status">
            {headline}
          </p>
          <p className="health-plate-detail">{detail}</p>
        </div>
        <ol className="health-plate-steps">
          <li>
            <b className="is-mono">config.toml / auth.json</b>
            <span>仅检查本机配置与文件引用</span>
          </li>
          <li>
            <b>结构与引用检查</b>
            <span>
              {report
                ? `${critical} 需处理 · ${warning} 建议${info > 0 ? ` · ${info} 提示` : ""}`
                : "等待检查完成"}
            </span>
          </li>
          <li>
            <b>只读报告</b>
            <span>不会写入配置或生成备份</span>
          </li>
        </ol>
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
          <HelpCircle size={16} aria-hidden="true" />
        </button>
      </div>

      {error && (
        <p className="health-message is-error" role="alert">
          配置体检失败，请点击「重新检查」重试。未显示旧结果。
        </p>
      )}
      {report && items.length === 0 && (
        <p className="health-message" role="status">
          本次已检查范围内未发现问题；这不代表所有运行时状态均正常。
        </p>
      )}
      {report && (
        <p className="health-message">
          检查时间：
          <time dateTime={report.checkedAt}>
            {new Date(report.checkedAt).toLocaleString()}
          </time>
        </p>
      )}
      {items.length > 0 && (
        <div className="health-results">
          {groups.map(({ tone, label, Icon }) => {
            const group = items.filter((item) => toneOf(item) === tone);
            if (group.length === 0) return null;
            return (
              <section
                key={tone}
                className="health-group"
                aria-labelledby={`health-group-${tone}`}
              >
                <h2 id={`health-group-${tone}`} className="health-group-title">
                  {label} · {group.length}
                </h2>
                <ul className="health-list">
                  {group.map((item) => (
                    <li key={item.id} className="health-item" data-tone={tone}>
                      <Icon
                        className="health-item-icon"
                        size={20}
                        aria-hidden="true"
                      />
                      <div className="health-item-body">
                        <p className="health-item-title">{item.title}</p>
                        <p className="health-item-location">{item.location}</p>
                        {tone === "info" ? (
                          <p className="health-item-solution">
                            {firstUseHints[issueCode(item)]}
                          </p>
                        ) : (
                          <>
                            {item.impact && (
                              <p className="health-item-impact">
                                {item.impact}
                              </p>
                            )}
                            {item.solution && (
                              <p className="health-item-solution">
                                {item.solution}
                              </p>
                            )}
                          </>
                        )}
                      </div>
                      {item.repairable && repairToken !== null && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!canRepair}
                          aria-label={`修复「${item.title}」`}
                          title="修复全部 Chimera 自有失效引用，需确认"
                          onClick={() => setConfirmation(repairToken)}
                        >
                          修复
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
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
