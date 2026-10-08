import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { piPluginCatalog } from "@/config/piPluginCatalog";
import { piApi } from "@/lib/api/pi";
import {
  piPluginsApi,
  parseOmpPlugins,
  validPluginTarget,
  type OmpPlugin,
  type PiRuntime,
  type PluginAction,
} from "@/lib/api/piPlugins";
import { settingsApi } from "@/lib/api/settings";

const labels: Record<PluginAction, string> = {
  version: "检测版本",
  installRuntime: "安装 oh-my-pi",
  list: "刷新插件状态",
  install: "安装",
  remove: "卸载",
  update: "更新",
  enable: "启用",
  disable: "停用",
  discover: "浏览已配置市场",
  markets: "查看市场源",
  addMarket: "添加市场源",
  removeMarket: "移除市场源",
  refreshMarkets: "刷新市场索引",
};
interface Pending {
  action: PluginAction;
  target: string;
  warning?: string;
}
interface Declaration {
  source: string;
  filtered: boolean;
}

export function PiPluginMarket({
  native,
  runtime = "pi",
  panel = "all",
}: {
  native: boolean;
  runtime?: PiRuntime;
  panel?: "all" | "plugins" | "runtime";
}) {
  const [view, setView] = useState<"catalog" | "installed">("catalog");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [target, setTarget] = useState("");
  const [market, setMarket] = useState("");
  const [busy, setBusy] = useState(false);
  useLightweightCloseBlocker(busy);
  const running = useRef(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");
  const [declarations, setDeclarations] = useState<Declaration[] | null>(null);
  const [plugins, setPlugins] = useState<OmpPlugin[] | null>(null);
  const [version, setVersion] = useState("");
  const refresh = async () => {
    const result = await piPluginsApi.run(runtime, "list");
    if (runtime === "omp") setPlugins(parseOmpPlugins(result));
    else {
      const doc = await piApi.read("settings");
      const packages = doc.value.packages;
      if (packages !== undefined && !Array.isArray(packages))
        throw new Error("Pi packages 配置不是数组。");
      setDeclarations(
        (Array.isArray(packages) ? packages : []).flatMap(
          (item): Declaration[] => {
            if (typeof item === "string")
              return [{ source: item, filtered: false }];
            if (
              item &&
              typeof item === "object" &&
              typeof item.source === "string"
            )
              return [{ source: item.source, filtered: true }];
            return [];
          },
        ),
      );
    }
    return result;
  };
  const run = async (action: PluginAction, value = "") => {
    if (!native || running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setOutput("");
    try {
      if (action === "list") {
        setDeclarations(null);
        setPlugins(null);
        setOutput(await refresh());
      } else {
        const result = await piPluginsApi.run(runtime, action, value);
        setOutput(result || `${labels[action]}完成。`);
        if (action === "version" || action === "installRuntime") {
          setVersion(
            action === "version"
              ? result
              : "安装已完成，请检测版本。若 PATH 尚未生效，请重启 Chimera。",
          );
        } else if (
          ["install", "remove", "update", "enable", "disable"].includes(action)
        ) {
          setDeclarations(null);
          setPlugins(null);
          try {
            await refresh();
          } catch (e) {
            setError(`操作已完成，但刷新失败：${String(e)}`);
          }
        }
      }
    } catch (e) {
      setError(String(e));
      if (action === "version") setVersion("");
      if (
        ["install", "remove", "update", "enable", "disable"].includes(action)
      ) {
        setDeclarations(null);
        setPlugins(null);
      }
    } finally {
      setPending(null);
      setBusy(false);
      running.current = false;
    }
  };
  const confirm = (action: PluginAction, value = "", warning?: string) => {
    if (native && !busy) setPending({ action, target: value, warning });
  };
  const openSource = async (url: string) => {
    try {
      if (native) await settingsApi.openExternal(url);
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setError(String(e));
    }
  };
  const filtered = piPluginCatalog.filter(
    (p) =>
      (!category || p.category === category) &&
      `${p.name} ${p.description} ${p.category}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const disabled = !native || busy;

  return (
    <section
      className="tool-support-panel"
      aria-label={
        panel === "runtime"
          ? "oh-my-pi 安装与更新"
          : `${runtime === "pi" ? "Pi" : "oh-my-pi"} 插件市场`
      }
    >
      <div className={`space-y-4 text-sm ${panel === "all" ? "p-4" : ""}`}>
        {runtime === "omp" && panel !== "plugins" && (
          <div
            className="flex flex-wrap items-center gap-2"
            role="group"
            aria-label="运行环境"
          >
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => void run("version")}
            >
              检测版本
            </Button>
            {runtime === "omp" && (
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() =>
                  confirm(
                    "installRuntime",
                    "",
                    "使用 Bun 全局安装固定版本 @oh-my-pi/pi-coding-agent@18.8.3，需要 Bun >= 1.3.14。会执行安装代码；已有其他版本时可能被替换。",
                  )
                }
              >
                安装 oh-my-pi
              </Button>
            )}
          </div>
        )}
        {panel !== "plugins" && version && (
          <p className="break-all text-muted-foreground">{version}</p>
        )}
        {panel === "runtime" && (
          <p className="text-muted-foreground">
            检测本机 omp，或通过 Bun 安装固定版本。已有版本可能被替换。
          </p>
        )}
        <div hidden={panel === "runtime"} className="space-y-4">
          <p className="text-muted-foreground">
            {runtime === "pi"
              ? "Pi：管理全局扩展包，包括扩展、技能、提示模板和主题。固定版本不会随更新自动升版。"
              : "oh-my-pi：通过原生管理器管理用户级插件。"}{" "}
            所有操作面向用户级配置，不修改项目配置。Pi 与 OMP 扩展不保证兼容。
          </p>
          {!native && (
            <p>
              {runtime === "pi"
                ? "可浏览推荐；安装和本地管理仅在桌面应用中可用。"
                : "市场发现、安装和本地管理仅在桌面应用中可用。"}
            </p>
          )}
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="市场视图"
          >
            <Button
              variant={view === "catalog" ? "default" : "outline"}
              aria-pressed={view === "catalog"}
              onClick={() => setView("catalog")}
            >
              {runtime === "pi" ? "精选推荐 · 10" : "原生市场"}
            </Button>
            <Button
              variant={view === "installed" ? "default" : "outline"}
              aria-pressed={view === "installed"}
              onClick={() => setView("installed")}
            >
              {runtime === "pi" ? "本地声明与状态" : "已安装插件"}
            </Button>
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => void run("list")}
            >
              刷新插件状态
            </Button>
          </div>
          {view === "catalog" && runtime === "pi" && (
            <>
              <p className="text-muted-foreground">
                首批候选按用途精选，2026-10-08 核对 npm
                清单；未做逐包运行或安全认证。安装前查看来源、依赖与提示。
              </p>
              <div className="flex flex-wrap gap-2">
                <Input
                  className="min-w-40 flex-1"
                  aria-label="搜索推荐插件"
                  placeholder="搜索名称、用途"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <select
                  className="rounded border bg-background px-3"
                  aria-label="插件分类"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  <option value="">全部分类</option>
                  {[...new Set(piPluginCatalog.map((p) => p.category))].map(
                    (name) => (
                      <option key={name}>{name}</option>
                    ),
                  )}
                </select>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {filtered.map((plugin) => {
                  const declared = declarations?.some(
                    (p) =>
                      p.source === `npm:${plugin.name}` ||
                      p.source.startsWith(`npm:${plugin.name}@`),
                  );
                  return (
                    <article
                      key={plugin.name}
                      className="flex min-w-0 flex-col gap-2 rounded-lg border bg-background p-4"
                      aria-label={plugin.name}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="break-all font-semibold">
                          {plugin.name}
                        </h3>
                        <span className="text-xs text-muted-foreground">
                          {plugin.category} · Pi
                        </span>
                      </div>
                      <p>{plugin.description}</p>
                      <p className="break-all text-xs text-muted-foreground">
                        v{plugin.version} · {plugin.license}
                        {declared ? " · 已声明（不代表已安装）" : ""}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {plugin.risk}
                      </p>
                      <details className="text-xs text-muted-foreground">
                        <summary>依赖约束</summary>
                        <pre className="whitespace-pre-wrap break-all">
                          {JSON.stringify(plugin.peers, null, 2)}
                        </pre>
                      </details>
                      <div className="mt-auto flex gap-2 pt-2">
                        <Button
                          size="sm"
                          disabled={disabled || declared}
                          onClick={() =>
                            confirm(
                              "install",
                              `${plugin.name}@${plugin.version}`,
                              plugin.risk,
                            )
                          }
                        >
                          安装固定版本
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void openSource(plugin.repository)}
                        >
                          查看源码
                        </Button>
                      </div>
                    </article>
                  );
                })}
              </div>
              {!filtered.length && (
                <p className="text-muted-foreground">没有匹配的推荐插件。</p>
              )}
            </>
          )}
          {view === "catalog" && runtime === "omp" && (
            <section
              aria-label="OMP 市场源管理"
              className="space-y-3 rounded-lg border p-4"
            >
              <h3 className="font-semibold">发现插件</h3>
              <p>
                浏览已配置市场，再填写“插件名@市场名”安装。发现结果显示在下方。
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={disabled}
                  onClick={() => void run("discover")}
                >
                  浏览已配置市场
                </Button>
              </div>
              <details className="space-y-3">
                <summary className="cursor-pointer text-sm text-muted-foreground">
                  管理市场源
                </summary>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={disabled}
                    onClick={() => void run("markets")}
                  >
                    查看市场源
                  </Button>
                  <Button
                    variant="outline"
                    disabled={disabled}
                    onClick={() => confirm("refreshMarkets")}
                  >
                    刷新市场索引
                  </Button>
                </div>
                <label className="block">
                  市场源（GitHub owner/repo；移除时填市场名称）
                  <Input
                    aria-label="OMP 市场源"
                    value={market}
                    disabled={busy}
                    onChange={(e) => setMarket(e.target.value)}
                    placeholder="例如 anthropics/claude-plugins-official"
                  />
                </label>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled={
                      disabled ||
                      !/^[a-zA-Z0-9][a-zA-Z0-9_-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(
                        market,
                      ) ||
                      market.length > 214
                    }
                    onClick={() =>
                      confirm(
                        "addMarket",
                        market,
                        "将下载该 GitHub 仓库的索引；市场兼容不代表每个插件兼容 OMP。",
                      )
                    }
                  >
                    添加市场源
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={
                      disabled ||
                      !/^[a-z0-9][a-z0-9._-]*$/.test(market) ||
                      market.length > 214
                    }
                    onClick={() => confirm("removeMarket", market)}
                  >
                    移除市场源
                  </Button>
                </div>
              </details>
            </section>
          )}
          {view === "installed" && (
            <section className="space-y-3" aria-label="本地插件">
              {runtime === "pi" ? (
                <>
                  <p>
                    声明不等于已安装。含资源筛选的声明不会在这里重写筛选规则。git
                    / 本地来源请在 Pi 终端管理。
                  </p>
                  {declarations === null ? (
                    <p>点击“刷新插件状态”读取原生列表与全局声明。</p>
                  ) : !declarations.length ? (
                    <p>没有全局扩展包声明。</p>
                  ) : (
                    declarations.map((item, index) => {
                      const spec = item.source.startsWith("npm:")
                        ? item.source.slice(4)
                        : "";
                      return (
                        <div
                          key={`${item.source}-${index}`}
                          className="flex flex-wrap items-center justify-between gap-2 rounded border p-3"
                        >
                          <span className="break-all">
                            {item.source}
                            {item.filtered ? "（含资源筛选）" : ""}
                          </span>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={disabled || !validPluginTarget(spec)}
                            onClick={() => confirm("remove", spec)}
                          >
                            卸载
                          </Button>
                        </div>
                      );
                    })
                  )}
                  <Button
                    variant="outline"
                    disabled={disabled}
                    onClick={() =>
                      confirm(
                        "update",
                        "",
                        "执行 pi update --extensions，更新全局扩展并保留固定版本；不会自动改成 latest。",
                      )
                    }
                  >
                    更新全局扩展
                  </Button>
                </>
              ) : (
                <>
                  {plugins === null ? (
                    <p>点击“刷新插件状态”读取 OMP 原生安装列表。</p>
                  ) : !plugins.length ? (
                    <p>尚未安装 OMP 插件。</p>
                  ) : (
                    plugins.map((plugin) => (
                      <div
                        key={plugin.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded border p-3"
                      >
                        <div className="min-w-0">
                          <p className="break-all font-medium">{plugin.id}</p>
                          <p className="text-xs text-muted-foreground">
                            {plugin.version} ·{" "}
                            {plugin.enabled === null
                              ? "启用状态未知"
                              : plugin.enabled
                                ? "已启用"
                                : "已停用"}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={disabled || !validPluginTarget(plugin.id)}
                            onClick={() => confirm("update", plugin.id)}
                          >
                            更新
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={
                              disabled ||
                              !validPluginTarget(plugin.id) ||
                              plugin.enabled === null
                            }
                            onClick={() =>
                              confirm(
                                plugin.enabled ? "disable" : "enable",
                                plugin.id,
                              )
                            }
                          >
                            {plugin.enabled ? "停用" : "启用"}
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={disabled || !validPluginTarget(plugin.id)}
                            onClick={() => confirm("remove", plugin.id)}
                          >
                            卸载
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                </>
              )}
            </section>
          )}
          <section
            className="space-y-2 rounded-lg border p-4"
            aria-label="按来源安装"
          >
            <h3 className="font-semibold">
              按来源安装到 {runtime === "pi" ? "Pi" : "oh-my-pi"}
            </h3>
            <p className="text-xs text-muted-foreground">
              只接受 npm 包名（建议带 @固定版本）
              {runtime === "omp"
                ? "或已配置的 插件名@市场名"
                : "，不带 npm: 前缀"}
              。不接受路径、URL 或命令参数。
            </p>
            <div className="flex gap-2">
              <Input
                aria-label="插件安装来源"
                value={target}
                disabled={busy}
                onChange={(e) => setTarget(e.target.value)}
                placeholder={
                  runtime === "pi"
                    ? "@scope/package@1.2.3"
                    : "package@1.2.3 或 name@marketplace"
                }
              />
              <Button
                disabled={disabled || !validPluginTarget(target)}
                onClick={() => confirm("install", target)}
              >
                安装此来源
              </Button>
            </div>
          </section>
        </div>
        {busy && (
          <p role="status">
            正在执行原生命令，请勿重复操作。通常数秒至数分钟，最长 10 分钟。
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="whitespace-pre-wrap break-all text-destructive"
          >
            {error}
          </p>
        )}
        {output && (
          <details open className="rounded border p-3">
            <summary>原生命令结果</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
              {output}
            </pre>
          </details>
        )}
        <p className="text-xs text-muted-foreground">
          {panel === "runtime"
            ? "安装需要 Bun >= 1.3.14。安装或更新后请重启 OMP；本页不接管运行中的会话。"
            : runtime === "omp"
              ? "插件可执行第三方代码，请确认来源可信。操作后可 /reload-plugins；新增工具、hooks 或扩展模块需重启会话。"
              : "扩展及依赖可以执行第三方代码，请确认来源可信。操作后请在 Pi 中 /reload。"}
        </p>
      </div>
      <ConfirmDialog
        isOpen={pending !== null}
        busy={busy}
        title={`${pending ? labels[pending.action] : ""} ${runtime === "pi" ? "Pi" : "oh-my-pi"}？`}
        message={`${pending?.target || "用户级全局范围"}\n${pending?.warning || "将由原生管理器修改用户级配置与插件文件。"}\n安装、更新、启用及加载可能执行第三方代码、访问文件或网络。请确认来源可信。`}
        variant={
          pending?.action === "remove" || pending?.action === "removeMarket"
            ? "destructive"
            : "info"
        }
        confirmText="确认执行"
        onCancel={() => {
          if (!busy) setPending(null);
        }}
        onConfirm={() => {
          if (pending) void run(pending.action, pending.target);
        }}
      />
    </section>
  );
}
