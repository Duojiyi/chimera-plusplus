import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import {
  ArrowDownToLine,
  Download,
  ExternalLink,
  Info,
  Loader2,
  Monitor,
  Plus,
  RefreshCw,
  Route,
  X,
} from "lucide-react";
import { providersApi, type ClaudeDesktopStatus } from "@/lib/api/providers";
import { settingsApi } from "@/lib/api/settings";
import { ClaudeDesktopRouteToggle } from "@/components/proxy/ClaudeDesktopRouteToggle";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import "./ToolViewDesktop.css";

// Official links published at https://claude.com/download. Keep architectures
// explicit: Windows browser user agents do not reliably distinguish ARM64.
const INSTALLERS = [
  {
    name: "Windows x64",
    detail: "Intel / AMD 处理器",
    url: "https://claude.ai/api/desktop/win32/x64/setup/latest/redirect",
  },
  {
    name: "Windows ARM64",
    detail: "ARM / Snapdragon 处理器",
    url: "https://claude.ai/api/desktop/win32/arm64/setup/latest/redirect",
  },
  {
    name: "macOS",
    detail: "通用安装包 · Apple Silicon / Intel",
    url: "https://claude.ai/api/desktop/darwin/universal/dmg/latest/redirect",
  },
];

export default function ToolViewDesktop({
  native,
  refreshVersion,
  onChanged,
  onSupported,
}: {
  native: boolean;
  refreshVersion: number;
  onChanged: () => Promise<void>;
  onSupported: (supported: boolean) => void;
}) {
  const [status, setStatus] = useState<ClaudeDesktopStatus | null>(null);
  const [loading, setLoading] = useState(native);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<"import" | "official" | null>(null);
  const [opening, setOpening] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [downloadNotice, setDownloadNotice] = useState("");
  const mounted = useRef(false);
  const generation = useRef(0);
  const actionPending = useRef(false);
  const linkPending = useRef(false);

  const load = useCallback(async () => {
    const request = ++generation.current;
    if (!native) {
      setStatus(null);
      setError("");
      setLoading(false);
      onSupported(false);
      return;
    }
    setLoading(true);
    setError("");
    onSupported(false);
    try {
      const next = await providersApi.getClaudeDesktopStatus();
      if (request !== generation.current) return;
      setStatus(next);
      onSupported(next.supported);
    } catch (cause) {
      if (request !== generation.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus(null);
      onSupported(false);
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [native, onSupported]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [load, refreshVersion]);

  const act = async (kind: "import" | "official") => {
    if (actionPending.current || !native || loading || !status?.supported)
      return;
    actionPending.current = true;
    setBusy(kind);
    setActionError("");
    setNotice("");
    try {
      const result =
        kind === "import"
          ? await providersApi.importClaudeDesktopFromClaude()
          : await providersApi.ensureClaudeDesktopOfficialProvider();
      if (!mounted.current) return;
      await onChanged();
      if (!mounted.current) return;
      setNotice(
        kind === "import"
          ? result
            ? `已导入 ${result} 条兼容线路，未切换当前配置。`
            : "没有新增兼容线路。请先在 Claude Code 页面导入本机配置；已存在的线路会跳过。"
          : result
            ? "已添加官方入口，未切换线路，也未执行账号登录。"
            : "官方入口已存在，未切换线路。",
      );
    } catch (cause) {
      if (mounted.current)
        setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      actionPending.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  const openLink = async (
    event: MouseEvent<HTMLAnchorElement>,
    url: string,
  ) => {
    // Browser preview uses a normal link; the native app uses its validated opener.
    if (!native) return;
    event.preventDefault();
    if (linkPending.current) return;
    linkPending.current = true;
    setOpening(true);
    setDownloadError("");
    setDownloadNotice("");
    try {
      await settingsApi.openExternal(url);
      if (mounted.current)
        setDownloadNotice(
          "已在浏览器打开官方链接。请下载安装包并手动运行，完成后返回重新检测。",
        );
    } catch (cause) {
      if (mounted.current)
        setDownloadError(
          cause instanceof Error ? cause.message : String(cause),
        );
    } finally {
      linkPending.current = false;
      if (mounted.current) setOpening(false);
    }
  };

  const installed = Boolean(status?.installationPath);
  const canConfigure =
    native && !loading && Boolean(status?.supported) && !busy;
  const installationLabel = !native
    ? "预览模式"
    : loading
      ? "检测中"
      : !status
        ? "状态未知"
        : installed
          ? "已检测到"
          : "未检测到";
  const configLabel = !native
    ? "仅桌面端可用"
    : loading
      ? "检测中"
      : !status
        ? "状态未知"
        : !status.supported
          ? "平台不支持"
          : status.configured
            ? "已配置第三方"
            : "尚未配置第三方";

  return (
    <section
      aria-label="Claude Desktop 配置状态"
      className="tool-desktop-panel"
    >
      <div className="tool-desktop-grid">
        <section
          className="tool-desktop-card"
          aria-labelledby="desktop-client-title"
        >
          <div className="tool-desktop-card-heading">
            <span className="tool-desktop-icon">
              <Monitor size={20} aria-hidden="true" />
            </span>
            <h2 id="desktop-client-title">桌面客户端</h2>
            <span
              className="tool-desktop-badge"
              data-tone={
                native && !loading && installed ? "success" : undefined
              }
            >
              {installationLabel}
            </span>
          </div>
          <h3>{installed ? "已找到本机客户端" : "安装 Claude Desktop"}</h3>
          <p className="tool-desktop-description">
            {!native
              ? "浏览器预览无法检测本机安装状态，可先获取官方安装包。"
              : loading
                ? "正在读取本机客户端与配置状态…"
                : !status
                  ? "暂时无法确认安装状态，请重试检测。"
                  : installed
                    ? "已找到程序文件。账号登录需在 Claude Desktop 中完成。"
                    : "标准路径未发现客户端。"}
          </p>
          <div className="tool-desktop-actions">
            <Dialog
              onOpenChange={() => {
                setDownloadError("");
                setDownloadNotice("");
              }}
            >
              <DialogTrigger asChild>
                <Button>
                  <Download size={15} aria-hidden="true" />
                  {installed ? "获取官方安装包" : "快速安装"}
                </Button>
              </DialogTrigger>
              <DialogContent className="tool-desktop-install-dialog">
                <DialogHeader className="relative pr-14">
                  <DialogTitle>快速安装 Claude Desktop</DialogTitle>
                  <DialogDescription>
                    选择与你的电脑匹配的官方安装包。不会自动安装或启动应用。
                  </DialogDescription>
                  <DialogClose asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute right-3 top-3"
                      aria-label="关闭安装指引"
                    >
                      <X size={18} />
                    </Button>
                  </DialogClose>
                </DialogHeader>
                <div className="tool-desktop-install-body">
                  <ol className="tool-desktop-install-steps">
                    <li>选择系统与处理器，使用浏览器下载安装包。</li>
                    <li>手动运行安装包，按官方提示完成安装。</li>
                    <li>返回此页重新检测，再选择需要的线路。</li>
                  </ol>
                  <div className="tool-desktop-downloads">
                    {INSTALLERS.map((installer) => (
                      <a
                        key={installer.name}
                        href={installer.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`下载 ${installer.name} 官方安装包`}
                        aria-disabled={opening || undefined}
                        onClick={(event) => void openLink(event, installer.url)}
                      >
                        <span>
                          <strong>{installer.name}</strong>
                          <small>{installer.detail}</small>
                        </span>
                        <Download size={18} aria-hidden="true" />
                      </a>
                    ))}
                  </div>
                  <p className="tool-desktop-hint">
                    不确定 Windows 架构？查看系统「设置 → 系统 → 关于 →
                    系统类型」。Linux 暂无官方 Desktop 安装包。
                  </p>
                  {downloadError && (
                    <p
                      className="tool-desktop-feedback"
                      data-tone="error"
                      role="alert"
                    >
                      无法打开官方链接：{downloadError}
                    </p>
                  )}
                  {downloadNotice && (
                    <p className="tool-desktop-feedback" role="status">
                      {downloadNotice}
                    </p>
                  )}
                </div>
                <DialogFooter>
                  <Button variant="ghost" asChild>
                    <a
                      href="https://claude.com/download"
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-disabled={opening || undefined}
                      onClick={(event) =>
                        void openLink(event, "https://claude.com/download")
                      }
                    >
                      官方下载页
                      <ExternalLink size={14} aria-hidden="true" />
                    </a>
                  </Button>
                  <DialogClose asChild>
                    <Button
                      variant="outline"
                      onClick={() => {
                        if (native) void load();
                      }}
                    >
                      {native ? "返回并重新检测" : "关闭"}
                    </Button>
                  </DialogClose>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Button
              variant="outline"
              disabled={!native || loading || Boolean(busy)}
              onClick={() => void load()}
            >
              <RefreshCw
                size={14}
                className={loading ? "animate-spin" : ""}
                aria-hidden="true"
              />
              {loading ? "正在检测…" : "重新检测"}
            </Button>
          </div>
          <p className="tool-desktop-hint">
            官方来源 · Windows / macOS · 下载后需手动安装
          </p>
        </section>

        <section
          className="tool-desktop-card"
          aria-labelledby="desktop-routes-title"
        >
          <div className="tool-desktop-card-heading">
            <span className="tool-desktop-icon tool-desktop-icon-route">
              <Route size={20} aria-hidden="true" />
            </span>
            <h2 id="desktop-routes-title">线路与连接</h2>
            <span
              className="tool-desktop-badge"
              data-tone={
                native && !loading && status?.configured ? "success" : undefined
              }
            >
              {configLabel}
            </span>
          </div>
          <p className="tool-desktop-description">
            {status && !status.supported
              ? "当前平台不支持 Desktop 第三方配置，相关操作已禁用。"
              : "添加官方入口，或导入已保存的 Claude Code 线路。"}
          </p>
          {native && status?.supported && (
            <div className="tool-desktop-route-control">
              <div>
                <strong>本地路由服务</strong>
                <p>
                  {status.mode === "proxy"
                    ? "代理模式 · 当前线路需要开启"
                    : status.mode === "direct"
                      ? "直连模式 · 当前线路无需开启"
                      : "用于模型映射与 API 格式转换"}
                </p>
              </div>
              <ClaudeDesktopRouteToggle disabled={loading || Boolean(busy)} />
            </div>
          )}
          <div className="tool-desktop-actions">
            <Button
              variant="outline"
              disabled={!canConfigure}
              onClick={() => void act("import")}
            >
              {busy === "import" ? (
                <Loader2
                  size={15}
                  className="animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <ArrowDownToLine size={15} aria-hidden="true" />
              )}
              {busy === "import" ? "正在导入…" : "从 Claude Code 导入"}
            </Button>
            <Button
              variant="ghost"
              disabled={!canConfigure}
              onClick={() => void act("official")}
            >
              <Plus size={15} aria-hidden="true" />
              {busy === "official" ? "正在添加…" : "添加官方入口"}
            </Button>
          </div>
          <p className="tool-desktop-hint">只保存导入，不切换当前配置。</p>
        </section>
      </div>
      {(error || actionError) && (
        <p className="tool-desktop-feedback" data-tone="error" role="alert">
          {error
            ? `无法读取 Desktop 状态：${error}`
            : `线路操作失败：${actionError}`}
        </p>
      )}
      {notice && (
        <p className="tool-desktop-feedback" role="status">
          {notice}
        </p>
      )}
      {status?.staleRawModels && (
        <p className="tool-desktop-feedback" data-tone="warning" role="alert">
          模型配置已过期，请重新应用线路。
        </p>
      )}
      {status?.missingRouteMappings && (
        <p className="tool-desktop-feedback" data-tone="warning" role="alert">
          缺少模型路由映射，请检查线路配置。
        </p>
      )}
      <div className="tool-desktop-note">
        <Info size={15} aria-hidden="true" />
        <span>切换后需手动重启 Claude Desktop；登录请在客户端完成。</span>
      </div>
      <details className="tool-desktop-details">
        <summary>诊断与兼容性</summary>
        <div>
          {status && (
            <dl>
              <dt>程序路径</dt>
              <dd>
                <code>{status.installationPath || "标准路径未检测到"}</code>
              </dd>
              <dt>连接模式</dt>
              <dd>
                {status.mode === "proxy"
                  ? "本地代理"
                  : status.mode === "direct"
                    ? "直连"
                    : "未设置"}
              </dd>
              {status.profilePath && (
                <>
                  <dt>Profile 路径</dt>
                  <dd>
                    <code>{status.profilePath}</code>
                  </dd>
                </>
              )}
              {status.configLibraryPath && (
                <>
                  <dt>配置库路径</dt>
                  <dd>
                    <code>{status.configLibraryPath}</code>
                  </dd>
                </>
              )}
            </dl>
          )}
          <p>
            安装探测只检查标准路径，未检测到不等于未安装；自定义路径与 MSIX
            安装可能无法识别。此处不管理自动升级或重启。
          </p>
          <p>
            导入来源是 Chimera 中已保存的 Claude Code 线路。仅有本机 API
            配置时，请先到 Claude Code 页面点击「导入本机配置」。
          </p>
          <p>
            Desktop 第三方模式暂不支持原生 MCP、扩展与 Skills 受管同步；Claude
            Code 的共享资源不等于 Desktop 原生资源。Linux
            不支持此处的第三方配置。
          </p>
        </div>
      </details>
    </section>
  );
}
