import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check } from "lucide-react";
import type { DeepLinkImportRequest } from "@/lib/api/deeplink";
import {
  classifyCommand,
  classifyEndpoint,
  maskArgs,
  maskUrl,
  maskValue,
  riskI18nKey,
  type RiskKind,
} from "@/utils/deeplinkRisk";
import { toolName } from "./tools";

type ServerSpec = Record<string, unknown>;

/** `mcpServers` of the backend preview, which is what will be stored. */
function serversOf(content: string | null): Array<[string, ServerSpec]> {
  if (!content) return [];
  try {
    const parsed = JSON.parse(content) as { mcpServers?: unknown };
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      return [];
    }
    return Object.entries(servers as Record<string, unknown>).map(
      ([id, spec]) => [
        id,
        spec && typeof spec === "object" && !Array.isArray(spec)
          ? (spec as ServerSpec)
          : {},
      ],
    );
  } catch {
    // Quiet on purpose: the config may hold secrets.
    return [];
  }
}

export function McpConfirmation({
  request,
  state,
  content,
  deniedEnvKeys,
}: {
  request: DeepLinkImportRequest;
  /** Whether the backend preview has loaded, or refused the link. */
  state: "loading" | "ready" | "failed";
  /** The backend preview's content: the decoded config, as it will be stored. */
  content: string;
  /** Env keys the backend deny list flags (from `preview_deeplink_import`). */
  deniedEnvKeys: ReadonlySet<string>;
}) {
  const { t } = useTranslation();
  const ids = useId();
  const servers = useMemo(() => serversOf(content), [content]);
  const targetApps = (request.apps ?? "")
    .split(",")
    .map((app) => app.trim())
    .filter(Boolean);

  const envRisk = (key: string): RiskKind | null =>
    deniedEnvKeys.has(key) ? "envHijack" : null;

  // 汇总所有条目命中的风险，在底部给一句总的提示——逐行的标记容易被划过去。
  // 每种风险都点名涉及的服务器，免得用户回头逐个去找。
  const risks = useMemo(() => {
    const found = new Map<RiskKind, string[]>();
    const add = (kind: RiskKind, id: string) => {
      const ids = found.get(kind) ?? [];
      if (!ids.includes(id)) found.set(kind, [...ids, id]);
    };
    for (const [id, spec] of servers) {
      const commandRisk = classifyCommand(spec.command, spec.args);
      if (commandRisk) add(commandRisk, id);
      if (typeof spec.url === "string") {
        const urlRisk = classifyEndpoint(spec.url);
        if (urlRisk) add(urlRisk, id);
      }
      const env = spec.env;
      if (env && typeof env === "object") {
        for (const key of Object.keys(env)) {
          if (deniedEnvKeys.has(key)) add("envHijack", id);
        }
      }
    }
    return [...found.entries()];
  }, [servers, deniedEnvKeys]);

  return (
    <>
      <dl className="dl-facts">
        <dt>{t("deeplink.mcp.targetApps")}</dt>
        <dd>
          <ul className="dl-tags">
            {targetApps.map((app) => (
              <li key={app}>{toolName(app)}</li>
            ))}
          </ul>
        </dd>
      </dl>

      {state === "loading" && <p className="dl-note">正在读取服务器配置…</p>}
      {state === "ready" && (
        <section className="dl-section" aria-labelledby={`${ids}-servers`}>
          <h3 id={`${ids}-servers`} className="dl-section-title">
            {t("deeplink.mcp.serverCount", { count: servers.length })}
          </h3>
          <ul className="dl-servers">
            {servers.map(([id, spec]) => {
              const commandRisk = classifyCommand(spec.command, spec.args);
              // Credentials after `--api-key`, in `--token=x`, in a header
              // or in a URL show their last 4 only, like every other
              // credential in this dialog. Masked in place, so nothing else
              // in an arg can be hidden by a link that picks its own "key".
              const args = Array.isArray(spec.args) ? maskArgs(spec.args) : [];
              const url =
                typeof spec.url === "string" ? maskUrl(spec.url) : null;
              const urlRisk =
                typeof spec.url === "string"
                  ? classifyEndpoint(spec.url)
                  : null;
              const env =
                spec.env && typeof spec.env === "object"
                  ? Object.entries(spec.env as Record<string, unknown>)
                  : [];
              const flagged =
                Boolean(commandRisk || urlRisk) ||
                env.some(([key]) => envRisk(key));
              return (
                <li
                  key={id}
                  className="dl-server"
                  data-risk={flagged || undefined}
                >
                  <div className="dl-server-head">
                    <span className="dl-server-name">{id}</span>
                    <span className="dl-tag">
                      {url ? "远程服务" : "本机命令"}
                    </span>
                  </div>
                  <dl className="dl-server-rows">
                    {spec.command !== undefined && (
                      <>
                        <dt>{t("deeplink.mcp.command")}</dt>
                        <dd
                          className="dl-mono"
                          data-risk={commandRisk ? true : undefined}
                        >
                          {String(spec.command)}
                        </dd>
                      </>
                    )}
                    {args.length > 0 && (
                      <>
                        <dt>{t("deeplink.mcp.args")}</dt>
                        {/* 逐项展开而不是 join(" ")：payload 常常整条藏在某一个 arg 里，
                            拼成一行再截断正是它此前得以隐身的原因。 */}
                        <dd>
                          <ol className="dl-args">
                            {args.map((arg, index) => (
                              <li
                                key={index}
                                className="dl-mono"
                                data-risk={commandRisk ? true : undefined}
                              >
                                {arg}
                              </li>
                            ))}
                          </ol>
                        </dd>
                      </>
                    )}
                    {url && (
                      <>
                        <dt>{t("deeplink.mcp.url")}</dt>
                        <dd
                          className="dl-mono"
                          data-risk={urlRisk ? true : undefined}
                        >
                          {url}
                        </dd>
                      </>
                    )}
                    {env.length > 0 && (
                      <>
                        <dt>{t("deeplink.mcp.env")}</dt>
                        <dd>
                          <ol className="dl-args">
                            {env.map(([key, value]) => (
                              <li
                                key={key}
                                className="dl-mono"
                                data-risk={envRisk(key) ? true : undefined}
                              >
                                {key}={maskValue(key, value)}
                              </li>
                            ))}
                          </ol>
                        </dd>
                      </>
                    )}
                  </dl>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {state === "ready" && risks.length > 0 && (
        <div className="dl-callout" data-tone="warning" role="note">
          <AlertTriangle size={15} aria-hidden="true" />
          <ul className="dl-callout-list">
            {risks.map(([kind, serverIds]) => (
              <li key={kind}>
                <span className="dl-mono dl-strong">
                  {serverIds.join("、")}
                </span>
                ：{t(riskI18nKey(kind))}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/*
        不看 `request.enabled`：MCP 导入路径不读这个字段，新服务器一律以
        停用状态保存（`deeplink/mcp.rs` 的 `McpApps::default()`），已存在的
        同名服务器保持原样。挂条件的话，恶意链接省略 `enabled` 就能改变
        这里的说法，而写入行为一模一样。
      */}
      {state === "ready" && (
        <section className="dl-section" aria-labelledby={`${ids}-outcome`}>
          <h3 id={`${ids}-outcome`} className="dl-section-title">
            确认后
          </h3>
          <div className="dl-card">
            <ul className="dl-outcome">
              <li>
                <Check size={14} aria-hidden="true" />
                <span>{t("deeplink.mcp.enabledWarning")}</span>
              </li>
              <li>
                <Check size={14} aria-hidden="true" />
                <span>已有同名的服务器保持原样，不会被链接覆盖。</span>
              </li>
            </ul>
            <p className="dl-card-note">
              需要时在「Skills 与 MCP」中为各个工具分别启用。
            </p>
          </div>
        </section>
      )}
    </>
  );
}
