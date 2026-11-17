import { useEffect, useId, useRef, useState } from "react";
import {
  Eye,
  EyeOff,
  MonitorCheck,
  FileDown,
  FileUp,
  Globe,
  KeyRound,
  Loader2,
  Plus,
  RotateCw,
  Terminal,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  AuthorizationLink,
  ManualAuthorization,
} from "@/components/accounts/BrowserAuthorization";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  claudeAccountsApi,
  type ClaudeLoginImportReport,
} from "@/lib/api/claudeAccounts";
import { errorText } from "./quota";
import { useReturnFocus } from "./useReturnFocus";

const POLL_INTERVAL_MS = 2_000;

/** Stops a flow without waiting; a flow that is already over is not an error. */
function endFlow(id: string) {
  void Promise.resolve()
    .then(() => claudeAccountsApi.cancelBrowserLogin(id))
    .catch(() => {});
}

type Browser =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "waiting"; id: string; url?: string | null }
  | { phase: "failed"; message: string };

/** What a pasted value looks like, by its prefix (the app checks it again). */
export function secretKind(
  value: string,
): "setup_token" | "api_key" | "refresh" | "json" | null {
  const text = value.trim();
  if (text.startsWith("{")) return "json";
  if (text.startsWith("sk-ant-oat")) return "setup_token";
  if (text.startsWith("sk-ant-ort")) return "refresh";
  if (text.startsWith("sk-ant-")) return "api_key";
  return null;
}

const SECRET_KIND_TEXT = {
  setup_token: "setup-token：长期令牌，只能用来推理",
  api_key: "Console API Key：按量计费",
  refresh: "这是 refresh token，不能单独添加",
  json: "凭证 JSON：claude-swap 的导出内容或 .credentials.json，按导入处理",
} as const;

type AddTab = "local" | "browser" | "token" | "import";

export interface AddAccountMenuProps {
  /** Another change to the accounts is running. */
  disabled: boolean;
  /** The app can start a browser authorization on this system. */
  browserSupported: boolean;
  /** Logins that can be written to a file. */
  exportable: number;
  /** Called after the saved logins changed, so the lists reload. */
  onChanged: () => void;
  /** Offered where signing in from a terminal and saving it makes sense. */
  onTerminalGuide?: () => void;
  /** The trigger's text. */
  label?: string;
  /**
   * `desktop`: the page of the Claude Desktop accounts. A login saved there
   * can be imported from Desktop directly. Browser-authorized Code logins
   * need an initial Desktop sign-in before one-click switching is available.
   */
  mode?: "code" | "desktop";
  /**
   * Sign-ins found on this computer, including managed ones that can be updated.
   * Desktop opens 本机导入 by default; each identity imports in one click.
   */
  detected?: readonly DetectedLogin[];
  onDetect?: () => Promise<void>;
  onCreateProfile?: () => void;
  onOpenDesktop?: () => void;
}

/** A sign-in on this computer that can be saved without picking a file. */
export interface DetectedLogin {
  id: string;
  /** Where it was found, e.g. 本机 Claude Desktop. */
  source: string;
  /** Who is signed in. */
  email: string | null;
  plan?: string | null;
  managed?: boolean;
  description?: string;
  onImport: () => void;
}

/**
 * Everything that adds a saved login or moves them as a file: a dialog with
 * browser authorization, a pasted token, key or login JSON, and imports; and
 * the export beside it. Shared by the Claude Code and Claude Desktop pages.
 */
export function AddAccountMenu({
  disabled,
  browserSupported,
  exportable,
  onChanged,
  onTerminalGuide,
  label = "添加账号",
  mode = "code",
  detected = [],
  onDetect,
  onCreateProfile,
  onOpenDesktop,
}: AddAccountMenuProps) {
  const tabsId = useId();
  const [browser, setBrowser] = useState<Browser>({ phase: "idle" });
  const [report, setReport] = useState<ClaudeLoginImportReport | null>(null);
  const [confirmExport, setConfirmExport] = useState(false);
  const [working, setWorking] = useState<"import" | "export" | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const tabs: { id: AddTab; label: string }[] = [
    ...(mode === "desktop"
      ? [{ id: "local" as const, label: "本机导入" }]
      : []),
    ...(browserSupported
      ? [{ id: "browser" as const, label: "浏览器授权" }]
      : []),
    ...(mode === "code"
      ? [{ id: "token" as const, label: "令牌 / JSON" }]
      : []),
    { id: "import", label: mode === "desktop" ? "文件导入" : "导入" },
  ];
  const [tab, setTab] = useState<AddTab>(tabs[0].id);
  const mounted = useRef(true);
  const flowId = useRef<string | null>(null);
  const flowGeneration = useRef(0);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const anyDialog =
    browser.phase !== "idle" || report !== null || confirmExport || addOpen;
  useReturnFocus(anyDialog);

  const waitingId = browser.phase === "waiting" ? browser.id : null;

  // Late startup results must be cancelled as well as an already waiting flow.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flowGeneration.current += 1;
      const id = flowId.current;
      flowId.current = null;
      if (id) endFlow(id);
    };
  }, []);

  useEffect(() => {
    if (!waitingId) return;
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      try {
        const result = await claudeAccountsApi.pollBrowserLogin(waitingId);
        if (stopped || flowId.current !== waitingId) return;
        if (result.state === "waiting") {
          setBrowser((current) =>
            current.phase === "waiting" && current.id === waitingId
              ? { ...current, url: result.authorizationUrl ?? current.url }
              : current,
          );
          timer = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
          return;
        }
        flowId.current = null;
        if (result.state === "done") {
          setBrowser({ phase: "idle" });
          toast.success(
            result.created
              ? `已添加「${result.account.name}」`
              : `「${result.account.name}」已更新为刚授权的登录`,
            {
              description:
                modeRef.current === "desktop"
                  ? "已保存。要让默认 Claude Desktop 用它：点账号卡片上的「登录并启用」，在回到登录页的 Desktop 里登录它，再点「保存 Desktop 登录」。"
                  : "Claude Code 当前的登录没有改动；要使用它，请在账号列表里切换。",
            },
          );
          onChangedRef.current();
          return;
        }
        endFlow(waitingId);
        setBrowser({
          phase: "failed",
          message:
            result.state === "failed"
              ? result.message
              : "这次授权已经结束，或应用被重启过。请重新开始。",
        });
      } catch (cause) {
        if (!stopped && flowId.current === waitingId) {
          flowId.current = null;
          endFlow(waitingId);
          setBrowser({ phase: "failed", message: errorText(cause) });
        }
      }
    };
    timer = window.setTimeout(() => void tick(), POLL_INTERVAL_MS / 2);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [waitingId]);

  const startBrowser = async () => {
    if (browser.phase === "starting") return;
    const generation = ++flowGeneration.current;
    const previous = flowId.current;
    flowId.current = null;
    if (previous) endFlow(previous);
    setAddOpen(false);
    setBrowser({ phase: "starting" });
    try {
      const id = await claudeAccountsApi.beginBrowserLogin();
      if (!mounted.current || generation !== flowGeneration.current) {
        endFlow(id);
        return;
      }
      flowId.current = id;
      setBrowser({ phase: "waiting", id });
    } catch (cause) {
      if (mounted.current && generation === flowGeneration.current)
        setBrowser({ phase: "failed", message: errorText(cause) });
    }
  };

  const cancelBrowser = () => {
    flowGeneration.current += 1;
    const id = flowId.current;
    flowId.current = null;
    if (id) endFlow(id);
    setBrowser({ phase: "idle" });
  };

  const showReport = (result: ClaudeLoginImportReport) => {
    setReport(result);
    if (result.imported.length > 0 || result.updated.length > 0)
      onChangedRef.current();
  };

  const importFile = async () => {
    if (working) return;
    setAddOpen(false);
    setWorking("import");
    try {
      const result = await claudeAccountsApi.importLogins();
      if (!mounted.current || result === null) return;
      showReport(result);
    } catch (cause) {
      if (mounted.current) toast.error(errorText(cause));
    } finally {
      if (mounted.current) setWorking(null);
    }
  };

  const exportFile = async () => {
    if (working) return;
    setWorking("export");
    try {
      const result = await claudeAccountsApi.exportLogins();
      if (!mounted.current) return;
      setConfirmExport(false);
      if (result === null) return;
      toast.success(`已导出 ${result.count} 个登录`, {
        description: `${result.path}${
          result.skipped > 0
            ? `（另有 ${result.skipped} 个缺少账号信息，没有导出）`
            : ""
        }。文件里是明文令牌，用完请删除。`,
      });
    } catch (cause) {
      if (mounted.current) {
        setConfirmExport(false);
        toast.error(errorText(cause));
      }
    } finally {
      if (mounted.current) setWorking(null);
    }
  };

  const browserOpen = browser.phase !== "idle";
  const busy = disabled || working !== null || browser.phase === "starting";
  const activeTab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;

  return (
    <div className="claude-login-tools">
      <Button
        size="icon"
        variant="ghost"
        disabled={busy || exportable === 0}
        aria-label="导出凭证文件"
        title={
          exportable === 0
            ? "还没有可导出的登录"
            : `导出凭证文件（${exportable} 个登录，明文保存）`
        }
        onClick={() => setConfirmExport(true)}
      >
        <FileDown size={15} aria-hidden="true" />
      </Button>
      <Button
        size="sm"
        disabled={busy || browserOpen}
        onClick={() => {
          setTab(
            mode === "desktop"
              ? "local"
              : detected.length > 0
                ? "import"
                : tabs[0].id,
          );
          setAddOpen(true);
        }}
      >
        <Plus size={14} aria-hidden="true" />
        {label}
      </Button>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="claude-accounts-dialog claude-add-dialog">
          <header className="claude-accounts-dialog-heading">
            <DialogTitle>{label}</DialogTitle>
            <Button
              variant="ghost"
              size="icon"
              aria-label="关闭添加账号"
              onClick={() => setAddOpen(false)}
            >
              <X size={16} aria-hidden="true" />
            </Button>
          </header>
          <DialogDescription>
            {mode === "desktop"
              ? "优先导入这台电脑已登录的账号，保存后会显示为账号卡片。"
              : "登录只保存在本机，加密存放；添加不会改动 Claude Code 当前的登录。"}
          </DialogDescription>
          <div className="claude-add-tabs" role="tablist" aria-label="添加方式">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`${tabsId}-${item.id}`}
                aria-selected={activeTab === item.id}
                aria-controls={`${tabsId}-${item.id}-panel`}
                onClick={() => setTab(item.id)}
              >
                {item.id === "local" ? (
                  <MonitorCheck size={14} aria-hidden="true" />
                ) : item.id === "browser" ? (
                  <Globe size={14} aria-hidden="true" />
                ) : item.id === "token" ? (
                  <KeyRound size={14} aria-hidden="true" />
                ) : (
                  <FileUp size={14} aria-hidden="true" />
                )}
                {item.label}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id={`${tabsId}-${activeTab}-panel`}
            aria-labelledby={`${tabsId}-${activeTab}`}
            className="claude-add-panel"
          >
            {activeTab === "local" ? (
              <div className="claude-local-import">
                <div className="claude-local-import-head">
                  <span>检测本机登录</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={detecting || disabled}
                    onClick={async () => {
                      setDetecting(true);
                      try {
                        await onDetect?.();
                      } finally {
                        setDetecting(false);
                      }
                    }}
                  >
                    <RotateCw
                      size={14}
                      className={detecting ? "animate-spin" : undefined}
                      aria-hidden="true"
                    />
                    {detecting ? "正在检测…" : "重新检测"}
                  </Button>
                </div>
                {detected.length > 0 ? (
                  detected.map((login) => (
                    <div key={login.id} className="claude-local-login">
                      <MonitorCheck size={22} aria-hidden="true" />
                      <div className="claude-local-login-identity">
                        <strong>
                          {login.email || "已登录的 Desktop 账号"}
                        </strong>
                        <span>
                          {login.source}
                          {login.plan ? " · " + login.plan : ""}
                        </span>
                        <small>
                          {login.description ||
                            (login.managed
                              ? "已在账号列表中，更新登录不会重复添加。"
                              : "保存本机登录后即可在账号之间切换。")}
                        </small>
                      </div>
                      <Button
                        disabled={disabled || detecting}
                        onClick={() => {
                          setAddOpen(false);
                          login.onImport();
                        }}
                      >
                        {login.managed ? "更新登录" : "导入账号"}
                      </Button>
                    </div>
                  ))
                ) : (
                  <div className="claude-local-empty">
                    <MonitorCheck size={28} aria-hidden="true" />
                    <strong>还没有检测到本机登录</strong>
                    <p>在 Claude Desktop 登录后，回到这里重新检测。</p>
                    {onOpenDesktop ? (
                      <Button
                        variant="outline"
                        onClick={() => {
                          setAddOpen(false);
                          onOpenDesktop();
                        }}
                      >
                        打开 Claude Desktop
                      </Button>
                    ) : null}
                  </div>
                )}
                <p className="claude-local-import-note">
                  登录信息仅保存在本机。导入前如需关闭 Desktop，会先提示你。
                </p>
              </div>
            ) : activeTab === "browser" ? (
              <>
                {mode === "desktop" ? (
                  <p className="claude-local-import-note">
                    授权后先添加账号；首次在 Desktop 使用时，还需在 Desktop
                    登录并保存一次。
                  </p>
                ) : null}
                <ol className="claude-accounts-steps">
                  <li>
                    浏览器会打开 claude.ai
                    的授权页，选择要添加的账号并点击「授权」。
                  </li>
                  <li>完成授权后，账号会自动保存到本机。</li>
                </ol>
                <p className="claude-accounts-note">
                  下一步也可以复制授权链接，或手动粘贴授权码、回调地址。
                </p>
                <footer className="claude-accounts-form-actions">
                  <Button onClick={() => void startBrowser()}>
                    <Globe size={14} aria-hidden="true" />
                    从浏览器授权添加
                  </Button>
                </footer>
              </>
            ) : activeTab === "token" ? (
              <SecretForm
                onCancel={() => setAddOpen(false)}
                onSaved={() => {
                  setAddOpen(false);
                  onChangedRef.current();
                }}
                onImported={(result) => {
                  setAddOpen(false);
                  showReport(result);
                }}
              />
            ) : (
              <div className="claude-add-options">
                {(mode === "code" ? detected : []).map((login) => (
                  <button
                    key={login.id}
                    type="button"
                    className="claude-add-option is-detected"
                    onClick={() => {
                      setAddOpen(false);
                      login.onImport();
                    }}
                  >
                    <MonitorCheck size={16} aria-hidden="true" />
                    <span>
                      <strong>导入{login.source}的登录</strong>
                      <small>
                        {login.email
                          ? `已检测到 ${login.email}，一键导入，不用选文件`
                          : "已检测到登录，一键导入，不用选文件"}
                      </small>
                    </span>
                  </button>
                ))}
                <button
                  type="button"
                  className="claude-add-option"
                  onClick={() => void importFile()}
                >
                  <FileUp size={16} aria-hidden="true" />
                  <span>
                    <strong>导入凭证文件</strong>
                    <small>claude-swap 的导出文件，或 .credentials.json</small>
                  </span>
                </button>
                {onTerminalGuide ? (
                  <button
                    type="button"
                    className="claude-add-option"
                    onClick={() => {
                      setAddOpen(false);
                      onTerminalGuide();
                    }}
                  >
                    <Terminal size={16} aria-hidden="true" />
                    <span>
                      <strong>在终端登录后保存</strong>
                      <small>用 /login 登录新账号，再保存当前登录</small>
                    </span>
                  </button>
                ) : null}
              </div>
            )}
          </div>
          {mode === "desktop" && onCreateProfile ? (
            <details className="claude-add-advanced">
              <summary>高级选项</summary>
              <p>需要多个账号同时打开时，可以创建独立窗口。</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setAddOpen(false);
                  onCreateProfile();
                }}
              >
                创建独立窗口
              </Button>
            </details>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={browserOpen}
        onOpenChange={(open) => {
          if (!open) cancelBrowser();
        }}
      >
        <DialogContent className="claude-accounts-dialog claude-auth-dialog">
          <header className="claude-accounts-dialog-heading">
            <DialogTitle>
              {browser.phase === "failed"
                ? "浏览器授权没有完成"
                : "在浏览器里授权 Claude 账号"}
            </DialogTitle>
            <Button
              variant="ghost"
              size="icon"
              aria-label="关闭授权"
              onClick={cancelBrowser}
            >
              <X size={16} aria-hidden="true" />
            </Button>
          </header>
          {browser.phase === "failed" ? (
            <>
              <DialogDescription>{browser.message}</DialogDescription>
              <footer className="claude-accounts-form-actions">
                <Button variant="outline" onClick={cancelBrowser}>
                  关闭
                </Button>
                <Button onClick={() => void startBrowser()}>重新开始</Button>
              </footer>
            </>
          ) : (
            <>
              <DialogDescription>
                用 Claude Code 官方的授权流程添加账号，不会改动 Claude Code
                当前的登录。
              </DialogDescription>
              {browser.phase === "waiting" && browser.url ? (
                <>
                  <AuthorizationLink
                    key={"link-" + browser.id}
                    url={browser.url}
                  />
                  <ManualAuthorization
                    key={"manual-" + browser.id}
                    mode="claude"
                    onSubmit={(input) =>
                      claudeAccountsApi.submitBrowserCallback(browser.id, input)
                    }
                  />
                </>
              ) : null}

              <p className="claude-accounts-note" role="status">
                <Loader2
                  size={14}
                  className="animate-spin"
                  aria-hidden="true"
                />
                {browser.phase === "starting"
                  ? "正在启动…"
                  : browser.phase === "waiting" && browser.url
                    ? "等待授权完成…（最多 15 分钟）"
                    : "等待授权完成…（授权链接准备中）"}
              </p>
              <footer className="claude-accounts-form-actions">
                <Button variant="outline" onClick={cancelBrowser}>
                  取消授权
                </Button>
              </footer>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={report !== null}
        onOpenChange={(open) => {
          if (!open) setReport(null);
        }}
      >
        <DialogContent className="claude-accounts-dialog">
          <header className="claude-accounts-dialog-heading">
            <DialogTitle>导入完成</DialogTitle>
            <Button
              variant="ghost"
              size="icon"
              aria-label="关闭导入结果"
              onClick={() => setReport(null)}
            >
              <X size={16} aria-hidden="true" />
            </Button>
          </header>
          <DialogDescription>
            {report
              ? `新增 ${report.imported.length} 个，更新 ${report.updated.length} 个，跳过 ${report.skipped.length} 个。`
              : ""}
          </DialogDescription>
          <ul className="claude-login-report">
            {report?.imported.map((account) => (
              <li key={`i:${account.id}`}>
                <strong>新增</strong>
                <span>{account.name}</span>
                {account.email && account.email !== account.name ? (
                  <small>{account.email}</small>
                ) : null}
              </li>
            ))}
            {report?.updated.map((account) => (
              <li key={`u:${account.id}`}>
                <strong>更新</strong>
                <span>{account.name}</span>
                <small>已用文件里的新登录替换了失效的那份</small>
              </li>
            ))}
            {report?.skipped.map((skipped, index) => (
              <li key={`s:${index}`} data-skipped="true">
                <strong>跳过</strong>
                <span>{skipped.email ?? "未识别的账号"}</span>
                <small>{skipped.reason}</small>
              </li>
            ))}
          </ul>
          {report?.notes?.map((note, index) => (
            <p key={`n:${index}`} className="claude-login-note" role="note">
              {note}
            </p>
          ))}
          <footer className="claude-accounts-form-actions">
            <Button onClick={() => setReport(null)}>知道了</Button>
          </footer>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        isOpen={confirmExport}
        busy={working === "export"}
        title="导出的文件里是明文令牌"
        message={`文件包含 ${exportable} 个账号的 access token 和 refresh token（API Key 也在其中），拿到它的人可以直接登录这些 Claude 账号。只保存在可信的位置，用完立即删除，不要上传或发给别人。格式与 claude-swap 兼容，可以导入那边使用。这是这台电脑上正在使用的同一份登录：拿到别处用了之后，这里的同一账号可能要重新登录。${mode === "desktop" ? "文件里没有 Claude Desktop 的登录：Desktop 的登录只在本机本用户有效，不能导出。" : ""}`}
        confirmText="我了解，选择保存位置"
        cancelText="取消"
        variant="destructive"
        onCancel={() => {
          if (working !== "export") setConfirmExport(false);
        }}
        onConfirm={() => void exportFile()}
      />
    </div>
  );
}

/** A pasted setup-token, Console API key, or login JSON. */
function SecretForm({
  onCancel,
  onSaved,
  onImported,
}: {
  onCancel: () => void;
  onSaved: () => void;
  onImported: (report: ClaudeLoginImportReport) => void;
}) {
  const secretId = useId();
  const nameId = useId();
  const [secret, setSecret] = useState("");
  const [name, setName] = useState("");
  const [shown, setShown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const kind = secretKind(secret);
  const accepted =
    kind === "setup_token" || kind === "api_key" || kind === "json";

  const submit = async () => {
    if (saving || !accepted) return;
    setSaving(true);
    setError("");
    try {
      if (kind === "json") {
        const result = await claudeAccountsApi.importLoginsText(secret);
        setSecret("");
        onImported(result);
        return;
      }
      const saved = await claudeAccountsApi.addSecret(secret, name);
      toast.success(`已添加「${saved.name}」`, {
        description:
          "没有联网验证。在这里切换到它，再在终端运行一次 claude，就能确认可用。",
      });
      setSecret("");
      setName("");
      onSaved();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="claude-accounts-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="claude-accounts-note">
        setup-token 在终端运行 <code>claude setup-token</code> 得到；API Key 在
        Anthropic Console 创建；也可以直接粘贴 claude-swap 的导出内容或
        .credentials.json 的内容。
      </p>
      <label htmlFor={secretId}>令牌或密钥</label>
      <div className="claude-secret-field">
        <Input
          id={secretId}
          type={shown ? "text" : "password"}
          value={secret}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-ant-… 或 { … }"
          onChange={(event) => {
            setSecret(event.target.value);
            setError("");
          }}
        />
        <button
          type="button"
          className="claude-secret-toggle"
          aria-label={shown ? "隐藏" : "显示"}
          aria-pressed={shown}
          onClick={() => setShown((value) => !value)}
        >
          {shown ? (
            <EyeOff size={15} aria-hidden="true" />
          ) : (
            <Eye size={15} aria-hidden="true" />
          )}
        </button>
      </div>
      <p
        className="claude-secret-kind"
        data-kind={kind ?? undefined}
        role="status"
      >
        {kind
          ? SECRET_KIND_TEXT[kind]
          : secret.trim()
            ? "无法识别：应以 sk-ant- 开头，或是一段 JSON"
            : "类型会根据开头自动识别"}
      </p>
      {kind !== "json" ? (
        <>
          <label htmlFor={nameId}>账号名称（可选）</label>
          <Input
            id={nameId}
            value={name}
            maxLength={40}
            placeholder="例如：CI 机器人"
            onChange={(event) => setName(event.target.value)}
          />
        </>
      ) : null}
      {error ? (
        <p className="claude-secret-error" role="alert">
          {error}
        </p>
      ) : null}
      <footer>
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={onCancel}
        >
          取消
        </Button>
        <Button type="submit" disabled={saving || !accepted}>
          {saving ? (
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          ) : null}
          {kind === "json" ? "导入" : "保存"}
        </Button>
      </footer>
    </form>
  );
}
