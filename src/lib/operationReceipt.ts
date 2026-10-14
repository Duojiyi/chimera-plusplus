// Turns what the Codex runtime and skin commands return into the plain-Chinese
// receipt the pages show: one conclusion, the next steps, and the raw text kept
// for "技术详情" and "复制诊断信息".

const CJK = /[㐀-鿿]/;

/** Restart scope shared by every flow that closes and relaunches Codex. */
export const CODEX_RESTART_SCOPE =
  "将关闭此安装目录下的所有 Codex 窗口（包括用其他工具打开的实例）并重新启动，未完成的操作会中断。";
/** Same scope for maintenance, which closes Codex without relaunching it. */
export const CODEX_CLOSE_SCOPE =
  "将关闭此安装目录下的所有 Codex 窗口（包括用其他工具打开的实例），未完成的操作会中断。";

export type ParsedOperationError = {
  /** Plain-Chinese conclusion; null when the backend text is not Chinese. */
  summary: string | null;
  /** The reason after the conclusion, when the backend gave one. */
  cause: string | null;
  /** "当前网络：…" sentence naming the proxy mode used. */
  network: string | null;
  /** Sentences that tell the user what to do next. */
  advice: string | null;
  raw: string;
};

export function errorText(error: unknown): string {
  const text =
    error instanceof Error ? error.message : String(error ?? "").trim();
  return text.replace(/^Error:\s*/, "").trim();
}

export const isPlainChinese = (text: string) => CJK.test(text);

function splitConclusion(text: string): { summary: string; cause: string } {
  const candidates = [text.indexOf("："), text.indexOf(": ")].filter(
    (index) => index > 0,
  );
  if (!candidates.length) return { summary: text, cause: "" };
  const index = Math.min(...candidates);
  const head = text.slice(0, index).trim();
  if (!CJK.test(head)) return { summary: text, cause: "" };
  const width = text.startsWith("：", index) ? 1 : 2;
  return { summary: head, cause: text.slice(index + width).trim() };
}

const stripStop = (sentence: string) => sentence.replace(/[。.]$/, "");

/**
 * Backend errors read "结论：原因。当前网络：…。请…". Split them so the page
 * can lead with the conclusion and turn the advice into buttons.
 */
export function parseOperationError(error: unknown): ParsedOperationError {
  const raw = errorText(error);
  if (!CJK.test(raw)) {
    return { summary: null, cause: null, network: null, advice: null, raw };
  }
  const sentences = raw
    .split(/(?<=。)/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const advice: string[] = [];
  const rest: string[] = [];
  let network: string | null = null;
  for (const sentence of sentences) {
    if (sentence.startsWith("当前网络")) network = sentence;
    else if (rest.length && /^(请|也可以|可以|如需|必要时)/.test(sentence))
      advice.push(sentence);
    else rest.push(sentence);
  }
  const [first = raw, ...more] = rest;
  const { summary, cause } = splitConclusion(stripStop(first));
  const causes = [cause, ...more.map(stripStop)].filter(Boolean);
  return {
    summary,
    cause: causes.length ? causes.join("。") : null,
    network,
    advice: advice.length ? advice.join("") : null,
    raw,
  };
}

/**
 * The sentence a receipt leads with. An English cause stays in the technical
 * details, so the visible line is always plain Chinese.
 */
export function conclusionLine(parsed: ParsedOperationError): string | null {
  if (!parsed.summary) return null;
  return parsed.cause && CJK.test(parsed.cause)
    ? `${parsed.summary}：${parsed.cause}。`
    : `${parsed.summary}。`;
}

/** Replace home directories with `~` before text leaves the machine. */
export function shortenHomePaths(text: string): string {
  return text
    .replace(
      /(?:\\\\\?\\)?[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>|:*?，。；）)]+/gi,
      "~",
    )
    .replace(/\/(?:Users|home)\/[^/\s"'<>|:*?，。；）)]+/g, "~");
}

export function formatReceiptTime(at: number, now = Date.now()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const time = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  if (date.toDateString() === new Date(now).toDateString())
    return `今天 ${time}`;
  const day = new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
  }).format(date);
  return `${day} ${time}`;
}

/** The journal stores Unix seconds; accept milliseconds as well. */
export const journalTimeMs = (value: number) =>
  value < 1e11 ? value * 1000 : value;

// Engine notes are English. Known ones become a plain sentence; `null` marks
// purely technical notes that only belong in the details.
const NOTE_TRANSLATIONS: ReadonlyArray<readonly [RegExp, string | null]> = [
  [
    /^Standard MSIX installation was unavailable or unhealthy/i,
    "标准安装不可用，已改为安装免安装版。",
  ],
  [
    /^Start menu shortcut was not created/i,
    "没有创建开始菜单快捷方式，可以从 Chimera++ 打开 Codex。",
  ],
  [
    /^Apps & Features uninstall entry was not created/i,
    "没有在 Windows“应用和功能”中登记卸载项，可以在 Chimera++ 中卸载。",
  ],
  [
    /^Portable rollback backup could not be removed/i,
    "旧版本的备份目录没有删除，可以稍后手动删除。",
  ],
  [
    /^Start Menu shortcut cleanup failed/i,
    "开始菜单快捷方式没有删除，可以手动删除。",
  ],
  [
    /^Apps & Features uninstall entry cleanup failed/i,
    "Windows“应用和功能”中的卸载项没有删除，可以在系统设置中手动移除。",
  ],
  [/^MSIX deployment is broken/i, "Windows 的 MSIX 部署服务不可用。"],
  [/^MSIX sideloading appears blocked/i, "Windows 当前禁止旁加载应用。"],
  [/ConstrainedLanguage/i, "PowerShell 处于受限语言模式，部分检测结果未知。"],
  [/^Sideload policy is not explicitly enabled/i, null],
  [/^Certificate trust is verified after/i, null],
];

/** Split backend notes into visible plain-Chinese lines and raw text. */
export function describeNotes(notes: readonly string[] | null | undefined): {
  visible: string[];
  technical: string[];
} {
  const visible: string[] = [];
  const technical: string[] = [];
  let unexplained = 0;
  for (const note of notes ?? []) {
    const text = note.trim();
    if (!text) continue;
    if (CJK.test(text)) {
      visible.push(text);
      continue;
    }
    technical.push(text);
    const match = NOTE_TRANSLATIONS.find(([pattern]) => pattern.test(text));
    if (!match) unexplained += 1;
    else if (match[1] && !visible.includes(match[1])) visible.push(match[1]);
  }
  if (unexplained) visible.push(`另有 ${unexplained} 条提示，见技术详情。`);
  return { visible, technical };
}

export type ReceiptNextStep =
  "retry" | "proxy" | "offline" | "diagnose" | "repair";

const NETWORK_FAILURE =
  /下载|网络|代理|连接|超时|HTTP|TLS|证书|DNS|github|rate limit|timed out|connection/i;

/** Buttons a failed runtime operation offers, most useful first. */
export function suggestNextSteps(
  parsed: ParsedOperationError,
  options: { downloads: boolean },
): ReceiptNextStep[] {
  const text = parsed.raw;
  if (/未检测到 Codex|没有可用的回滚备份|需要用户明确确认/.test(text))
    return [];
  const steps: ReceiptNextStep[] = [];
  const add = (step: ReceiptNextStep) => {
    if (!steps.includes(step)) steps.push(step);
  };
  add("retry");
  if (NETWORK_FAILURE.test(text)) {
    add("proxy");
    if (options.downloads) add("offline");
  }
  if (/执行“修复”|修复安装/.test(text)) add("repair");
  if (/运行诊断/.test(text)) add("diagnose");
  return steps.slice(0, 3);
}

/** Text for "复制诊断信息": labelled lines, home paths shortened. */
export function buildReport(
  heading: string,
  fields: ReadonlyArray<readonly [string, string | null | undefined]>,
  detail?: string | null,
): string {
  const lines = [heading];
  for (const [label, value] of fields) {
    if (value) lines.push(`${label}：${value}`);
  }
  if (detail) lines.push("", "技术详情：", detail);
  return shortenHomePaths(lines.join("\n"));
}
