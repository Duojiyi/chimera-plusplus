import { parse as parseToml } from "smol-toml";

/**
 * 将常见的中文/全角/弯引号统一为 ASCII 引号，以避免 TOML 解析失败。
 * - 双引号：” “ „ ‟ ＂ → "
 * - 单引号：’ ‘ ＇ → '
 * 保守起见，不替换书名号/角引号（《》、「」等），避免误伤内容语义。
 */
export const normalizeQuotes = (text: string): string => {
  if (!text) return text;
  return (
    text
      // 双引号族 → "
      .replace(/[“”„‟＂]/g, '"')
      // 单引号族 → '
      .replace(/[‘’＇]/g, "'")
  );
};

const SMART_DOUBLE_QUOTES = new Set(["“", "”", "„", "‟", "＂"]);
const SMART_SINGLE_QUOTES = new Set(["‘", "’", "＇"]);

/** 字符所属的引号族（ASCII 或弯/全角引号），不是引号时返回 null。 */
const quoteFamily = (ch: string): '"' | "'" | null => {
  if (ch === '"' || SMART_DOUBLE_QUOTES.has(ch)) return '"';
  if (ch === "'" || SMART_SINGLE_QUOTES.has(ch)) return "'";
  return null;
};

/**
 * 扫描 TOML 文本，只把充当字符串定界符的弯/全角引号换成 ASCII 引号：
 * - 字符串外的弯引号是定界符，换成 ASCII 并开启字符串；
 * - 弯引号开启的字符串，同族弯引号或 ASCII 引号都能关闭它；
 * - ASCII 开启的字符串里的弯引号是内容；`lenient` 时同族弯引号也能关闭；
 *   严格模式下到行尾（多行字符串到文末）都没关上时，回头按宽松规则重扫——
 *   编辑器逐字归一化，输入法打出的左引号已是 ASCII，右引号要靠这一步认出来；
 * - 基本字符串里的 `\“` 不是合法 TOML，按 `\"` 处理；注释原样保留。
 *
 * Adapted from farion1231/cc-switch 1f1becfb
 */
const scanTomlQuotes = (text: string, lenient: boolean): string => {
  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    if (ch === "#") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }

    const family = quoteFamily(ch);
    if (!family) {
      out += ch;
      i += 1;
      continue;
    }

    const multiline =
      i + 2 < n &&
      quoteFamily(text[i + 1]) === family &&
      quoteFamily(text[i + 2]) === family;
    const openLen = multiline ? 3 : 1;
    const openedBySmart = text.slice(i, i + openLen) !== family.repeat(openLen);
    const bodyStart = i + openLen;
    out += family.repeat(openLen);

    const scan = (
      acceptSmart: boolean,
    ): { body: string; next: number } | null => {
      let body = "";
      let j = bodyStart;
      const isCloser = (c: string) =>
        c === family || (acceptSmart && quoteFamily(c) === family);

      while (j < n) {
        const c = text[j];
        if (
          family === '"' &&
          c === "\\" &&
          j + 1 < n &&
          (multiline || text[j + 1] !== "\n")
        ) {
          const escaped = text[j + 1];
          body += "\\" + (quoteFamily(escaped) === '"' ? '"' : escaped);
          j += 2;
          continue;
        }
        if (!multiline && c === "\n") return null;
        if (!isCloser(c)) {
          body += c;
          j += 1;
          continue;
        }
        if (!multiline) return { body: body + family, next: j + 1 };
        // 多行字符串：连续 3 个及以上定界符才关闭（多出的至多 2 个属于内容）。
        let run = 0;
        while (j + run < n && isCloser(text[j + run])) run += 1;
        if (run >= 3) {
          return { body: body + family.repeat(run), next: j + run };
        }
        body += text.slice(j, j + run);
        j += run;
      }
      return null;
    };

    const acceptSmart = lenient || openedBySmart;
    const result = scan(acceptSmart) ?? (acceptSmart ? null : scan(true));
    if (result) {
      out += result.body;
      i = result.next;
      continue;
    }

    // 没有闭合：原样输出到行尾（多行字符串到文末），交给解析器报错。
    const end = multiline ? n : text.indexOf("\n", bodyStart);
    const stop = end === -1 ? n : end;
    out += text.slice(bodyStart, stop);
    i = stop;
  }

  return out;
};

const parsesAsToml = (text: string): boolean => {
  try {
    parseToml(text);
    return true;
  } catch {
    return false;
  }
};

/**
 * 专用于 TOML 文本的归一化：只把语法位置的弯/全角引号换成 ASCII 引号，合法字符串
 * 里的内容原样保留（以前全局替换会把 `args = ["don’t"]` 改成 `don't`，还会让
 * `"say“hello”"` 这类合法值无法解析）。严格结果解析失败、宽松结果能解析时才用
 * 宽松结果，所以合法文档里的字符串内容不会被改写。不含弯引号的文本原样返回。
 */
export const normalizeTomlText = (text: string): string => {
  if (!text || !/[“”„‟＂‘’＇]/.test(text)) return text;

  const strict = scanTomlQuotes(text, false);
  if (parsesAsToml(strict)) return strict;
  const lenient = scanTomlQuotes(text, true);
  return lenient !== strict && parsesAsToml(lenient) ? lenient : strict;
};
