import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  RotateCw as ArrowsClockwise,
  Wrench,
  HelpCircle as Question,
  XCircle,
  AlertTriangle as Warning,
} from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";
import {
  configHealthApi,
  type ConfigHealthReport,
} from "@/lib/api/configHealth";

export const ConfigHealthView: React.FC = () => {
  const [report, setReport] = useState<ConfigHealthReport | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);
  const mutation = useRef(false);
  useLightweightCloseBlocker(repairing);
  const handleRecheck = useCallback(async () => {
    const request = ++generation.current;
    setChecking(true);
    setError(false);
    setReport(null);
    try {
      const result = await configHealthApi.check();
      if (request === generation.current) setReport(result);
    } catch {
      if (request === generation.current) setError(true);
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
  const criticalCount = items.filter((i) => i.severity === "critical").length;
  const warningCount = items.filter((i) => i.severity === "warning").length;

  return (
    <div className="connected-page text-[var(--text-1)] min-h-full box-border w-full flex flex-col gap-[12px] p-[12px_24px] justify-start items-start bg-[var(--bg-surface)] min-h-0">
      {/* 页头 */}
      <div className="box-border w-full h-fit shrink-0 flex flex-row gap-[12px] justify-start items-center">
        <div className="box-border min-w-0 [flex:1_1_0] h-fit flex flex-col gap-[2px] justify-start items-start">
          <div className="box-border w-fit h-fit shrink-0 flex flex-row gap-[10px] justify-start items-center">
            <h1 className="text-[28px]/[36px] box-border text-[var(--text-1)] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold text-left whitespace-nowrap m-0">
              配置体检
            </h1>
          </div>
          <div className="text-[13px]/[18px] box-border text-[var(--text-3)] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal text-left whitespace-nowrap">
            检查 config.toml、auth.json 与引用文件 · 修复需单独确认
          </div>
        </div>
        <div className="box-border w-fit shrink-0 h-fit flex flex-row gap-[8px] justify-start items-center">
          <button
            type="button"
            onClick={handleRecheck}
            disabled={checking || repairing || confirmation !== null}
            className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] px-[12px] justify-center items-center bg-[var(--bg-surface)] outline outline-1 outline-[var(--border-control)] -outline-offset-[0.5px] rounded-[4px] border-none cursor-pointer text-[var(--text-1)] hover:bg-[var(--bg-subtle)] transition-colors"
          >
            <ArrowsClockwise
              size={16}
              className={checking ? "animate-spin" : ""}
            />
            <span className="text-[14px]/[20px] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal whitespace-nowrap">
              重新检查
            </span>
          </button>
          <button
            type="button"
            disabled={
              checking ||
              repairing ||
              !report?.repairToken ||
              !items.some((item) => item.repairable)
            }
            onClick={() => setConfirmation(report?.repairToken ?? null)}
            title="仅清理 Chimera 自有的失效指令引用，不改用户外部路径"
            className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] px-[12px] justify-center items-center bg-[#006AA0] hover:bg-[#005a88] active:bg-[#004e76] transition-colors rounded-[4px] border-none cursor-pointer text-[#FDFDFE]"
          >
            <Wrench size={16} />
            <span className="text-[14px]/[20px] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal whitespace-nowrap">
              {repairing ? "正在修复…" : "修复自有引用"}
            </span>
          </button>
        </div>
      </div>

      {/* 状态头 · 配置体检 (深色石墨灯箱 1:1) */}
      <div className="box-border w-full h-fit shrink-0 flex flex-row gap-[24px] p-[16px_16px_16px_24px] justify-start items-center bg-[#1A1E24] outline outline-1 outline-[#1A1E24] -outline-offset-[0.5px] rounded-[8px] overflow-hidden text-[#F5F7F9]">
        {/* 标题区 */}
        <div className="box-border w-[200px] shrink-0 h-fit flex flex-col gap-[2px] justify-start items-start">
          <div className="text-[13px]/[18px] box-border text-[#94999E] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal text-left whitespace-nowrap">
            {checking
              ? "正在检查本地配置"
              : report
                ? "本次检查已完成"
                : "尚无检查结果"}
          </div>
          <div className="text-[22px]/[25px] box-border text-[#F5F7F9] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold text-left whitespace-nowrap">
            {checking
              ? "正在检查…"
              : error
                ? "检查失败"
                : `${criticalCount} 项需处理`}
          </div>
          <div className="text-[13px]/[18px] box-border text-[#B4B8BC] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal text-left whitespace-nowrap">
            {report ? `${warningCount} 条建议 · 只读检测` : "尚无有效检测结果"}
          </div>
        </div>

        {/* 3 节点路径条 */}
        <div className="box-border [flex:1_1_0] h-fit flex flex-row gap-0 justify-start items-start">
          {/* 站 1 */}
          <div className="box-border min-w-0 [flex:1_1_0] h-fit flex flex-col gap-[10px] justify-start items-start">
            <div className="box-border w-full h-[12px] shrink-0 flex flex-row gap-0 justify-start items-center">
              <div className="box-border w-[12px] shrink-0 h-[12px] bg-[#1A1E24] border-2 border-solid border-[#B4B8BC] rounded-full" />
              <div className="box-border [flex:1_1_0] h-[2px] bg-[#94999E]" />
            </div>
            <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[2px] pr-[12px] justify-start items-start">
              <div className="text-[13px]/[18px] text-[#F5F7F9] font-['Overpass_Mono',system-ui,sans-serif] whitespace-nowrap">
                config.toml / auth.json
              </div>
              <div className="text-[13px]/[18px] w-full text-[#94999E] font-['Noto_Sans_SC',system-ui,sans-serif]">
                仅检查本机配置与文件引用
              </div>
            </div>
          </div>

          {/* 站 2 */}
          <div className="box-border min-w-0 [flex:1_1_0] h-fit flex flex-col gap-[10px] justify-start items-start">
            <div className="box-border w-full h-[12px] shrink-0 flex flex-row gap-0 justify-start items-center">
              <div className="box-border w-[12px] shrink-0 h-[12px] bg-[#1A1E24] border-2 border-solid border-[#B4B8BC] rounded-full" />
              <div className="box-border [flex:1_1_0] h-[2px] bg-[#94999E]" />
            </div>
            <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[2px] pr-[12px] justify-start items-start">
              <div className="text-[13px]/[18px] text-[#F5F7F9] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold whitespace-nowrap">
                结构与引用检查
              </div>
              <div className="text-[13px]/[18px] w-full text-[#94999E] font-['Noto_Sans_SC',system-ui,sans-serif]">
                {report
                  ? `${criticalCount} 需处理 · ${warningCount} 建议`
                  : "等待检查完成"}
              </div>
            </div>
          </div>

          {/* 站 3 */}
          <div className="box-border min-w-0 [flex:1_1_0] h-fit flex flex-col gap-[10px] justify-start items-start">
            <div className="box-border w-full h-[12px] shrink-0 flex flex-row gap-0 justify-start items-center">
              <div className="box-border w-[12px] shrink-0 h-[12px] bg-[#F5F7F9] border-2 border-solid border-[#F5F7F9] rounded-full" />
            </div>
            <div className="box-border w-full h-fit shrink-0 flex flex-col gap-[2px] pr-[12px] justify-start items-start">
              <div className="text-[13px]/[18px] text-[#F5F7F9] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold whitespace-nowrap">
                只读报告
              </div>
              <div className="text-[13px]/[18px] w-full text-[#94999E] font-['Noto_Sans_SC',system-ui,sans-serif]">
                不会写入配置或生成备份
              </div>
            </div>
          </div>
        </div>

        {/* 帮助图标 */}
        <button
          aria-label="了解配置体检范围"
          type="button"
          onClick={() =>
            toast.info(
              "检查配置结构、供应商与文件引用。不检测端口连通性、不修改配置、不回显密钥。",
            )
          }
          className="box-border w-[28px] shrink-0 h-[28px] flex justify-center items-center outline outline-1 outline-[#6F757B] -outline-offset-[0.5px] rounded-[4px] bg-transparent text-[#B4B8BC] hover:text-white cursor-pointer"
        >
          <Question size={16} aria-hidden="true" />
        </button>
      </div>

      {checking && <p role="status">正在读取本机配置…</p>}
      {error && <p role="alert">配置体检失败，请重新检查。未显示示例结果。</p>}
      {report && items.length === 0 && (
        <p role="status">
          本次已检查范围内未发现问题；这不代表所有运行时状态均正常。
        </p>
      )}
      {report && (
        <p className="text-sm text-muted-foreground">
          检查时间：
          <time dateTime={report.checkedAt}>
            {new Date(report.checkedAt).toLocaleString()}
          </time>
        </p>
      )}
      {/* 检查结果列表 */}
      <div className="box-border w-full h-fit shrink-0 flex flex-col gap-0 justify-start items-start">
        {/* 分组一：需修复 */}
        <div className="text-[13px]/[18px] box-border text-[var(--text-2)] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold text-left whitespace-nowrap py-[8px]">
          需修复 · {criticalCount}
        </div>

        {items
          .filter((i) => i.severity === "critical")
          .map((item) => {
            return (
              <React.Fragment key={item.id}>
                <div className="box-border w-full min-h-[66.5px] shrink-0 flex flex-row gap-[12px] p-[12px_12px_12px_16px] justify-start items-start border-b border-solid border-[var(--border-subtle)]">
                  <XCircle
                    size={20}
                    className="text-[#BE2323] shrink-0 mt-[2px]"
                  />
                  <div className="box-border min-w-0 [flex:1_1_0] h-fit flex flex-col gap-[4px] justify-start items-start">
                    <div className="text-[15px]/[21px] text-[var(--text-1)] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal text-left break-all">
                      {item.title}
                    </div>
                    <div className="text-[13px]/[18px] text-[var(--text-3)] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal text-left break-all">
                      {item.location}
                    </div>
                    {item.impact && (
                      <div className="text-[13px]/[18px] w-full text-[var(--text-2)] font-['Noto_Sans_SC',system-ui,sans-serif]">
                        {item.impact}
                      </div>
                    )}
                    {item.solution && (
                      <div className="text-[13px]/[18px] w-full text-[var(--text-1)] font-['Noto_Sans_SC',system-ui,sans-serif]">
                        {item.solution}
                      </div>
                    )}
                  </div>

                  {/* 操作栏 */}
                  <div className="box-border w-fit shrink-0 h-fit flex flex-row gap-[4px] justify-start items-center">
                    <button
                      type="button"
                      disabled={
                        checking ||
                        repairing ||
                        !report?.repairToken ||
                        !item.repairable
                      }
                      onClick={() =>
                        setConfirmation(report?.repairToken ?? null)
                      }
                      title={
                        item.repairable
                          ? "修复全部 Chimera 自有失效引用，需确认"
                          : "此项需按建议手动处理"
                      }
                      className="box-border w-fit shrink-0 h-[28px] flex flex-row gap-[6px] px-[12px] justify-center items-center bg-[var(--bg-surface)] outline outline-1 outline-[var(--border-control)] -outline-offset-[0.5px] rounded-[4px] border-none cursor-pointer text-[var(--text-1)] hover:bg-[var(--bg-subtle)]"
                    >
                      <span className="text-[13px]/[18px] font-['Noto_Sans_SC',system-ui,sans-serif] whitespace-nowrap">
                        修复
                      </span>
                    </button>
                  </div>
                </div>
              </React.Fragment>
            );
          })}

        {/* 分组二：建议 */}
        <div className="text-[13px]/[18px] box-border text-[var(--text-2)] font-['Noto_Sans_SC',system-ui,sans-serif] font-bold text-left whitespace-nowrap py-[8px] pt-[16px]">
          建议 · {warningCount}
        </div>

        {items
          .filter((i) => i.severity === "warning")
          .map((item) => (
            <div
              key={item.id}
              className="box-border w-full min-h-[66.5px] shrink-0 flex flex-row gap-[12px] p-[12px_12px_12px_16px] justify-start items-start border-b border-solid border-[var(--border-subtle)]"
            >
              <Warning size={20} className="text-[#915C08] shrink-0 mt-[2px]" />
              <div className="box-border min-w-0 [flex:1_1_0] h-fit flex flex-col gap-[4px] justify-start items-start">
                <div className="text-[15px]/[21px] text-[var(--text-1)] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal text-left break-all">
                  {item.title}
                </div>
                <div className="text-[13px]/[18px] text-[var(--text-3)] font-['Noto_Sans_SC',system-ui,sans-serif] font-normal text-left break-all">
                  {item.location}
                </div>
                <div className="text-[13px]/[18px] text-[var(--text-2)]">
                  {item.impact}
                </div>
                <div className="text-[13px]/[18px] text-[var(--text-1)]">
                  {item.solution}
                </div>
              </div>
              <div className="box-border w-fit shrink-0 h-fit flex flex-row gap-[4px] justify-start items-center">
                <button
                  type="button"
                  disabled={
                    checking ||
                    repairing ||
                    !report?.repairToken ||
                    !item.repairable
                  }
                  onClick={() => setConfirmation(report?.repairToken ?? null)}
                  title="按确认范围修复 Chimera 自有失效引用"
                  className="box-border w-fit shrink-0 h-[28px] flex flex-row gap-[6px] px-[12px] justify-center items-center bg-[var(--bg-surface)] outline outline-1 outline-[var(--border-control)] -outline-offset-[0.5px] rounded-[4px] border-none cursor-pointer text-[var(--text-1)] hover:bg-[var(--bg-subtle)]"
                >
                  <span className="text-[13px]/[18px] font-['Noto_Sans_SC',system-ui,sans-serif] whitespace-nowrap">
                    修复
                  </span>
                </button>
              </div>
            </div>
          ))}
      </div>
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
