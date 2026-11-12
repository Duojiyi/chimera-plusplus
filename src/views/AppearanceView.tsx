import "@/theme/v3/appearance.css";
import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ChevronRight,
  Download,
  ImageOff,
  Info,
  Palette,
  RotateCw,
  Search,
  ShieldCheck,
  WifiOff,
} from "lucide-react";
import { toast } from "sonner";
import { Empty } from "@/components/Empty";
import { settingsApi } from "@/lib/api/settings";
import {
  APPEARANCE_DESIGN_SAMPLE,
  isAppearanceDesignPreview,
} from "./AppearanceView.designSamples";

const runningInTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
// Previews come from a CDN that can stall. After this long the main preview
// reports a failure with a retry instead of shimmering indefinitely.
const PREVIEW_TIMEOUT_MS = 20_000;
const SKELETON_CARDS = 5;

type CatalogSkin = {
  id: string;
  name: string;
  description?: string;
  version: string;
  author?: string;
  appearance?: "dark" | "light" | "dual" | string | null;
  preview: string;
  installed: boolean;
  applied: boolean;
};
type Filter = "featured" | "installed" | "dark" | "light";

const FILTERS: ReadonlyArray<readonly [Filter, string]> = [
  ["featured", "精选"],
  ["installed", "已安装"],
  ["dark", "深色"],
  ["light", "浅色"],
];

function skinToneClass(skin: CatalogSkin) {
  const identity = `${skin.id} ${skin.name}`.toLowerCase();
  if (identity.includes("oled") || identity.includes("mono")) {
    return "skin-tone-oled";
  }
  if (identity.includes("sakura") || identity.includes("pink")) {
    return "skin-tone-sakura";
  }
  return "skin-tone-nerv";
}

function skinPreviewUrl(preview: string) {
  return /^(?:https?:\/\/|\/(?!\/))/.test(preview)
    ? preview
    : `https://skins.agentsmirror.com/${preview.replace(/^\/+/, "")}`;
}

/**
 * A fixed 16:10 frame that shows a skeleton until its image has decoded, then
 * fades the image in. Failures are shared by URL so a thumbnail and the large
 * preview of the same skin fail and retry together.
 */
function SkinArt({
  url,
  alt,
  size,
  failed,
  onFail,
  onRetry,
}: {
  url: string;
  alt: string;
  size: "thumb" | "stage";
  failed: boolean;
  onFail: (url: string) => void;
  onRetry?: () => void;
}) {
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const loaded = loadedUrl === url;
  const stage = size === "stage";
  useEffect(() => {
    if (!stage || failed || loaded) return;
    const timer = window.setTimeout(() => onFail(url), PREVIEW_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [stage, failed, loaded, url, onFail]);
  const state = failed ? "failed" : loaded ? "loaded" : "loading";
  return (
    <span
      className={`skin-art skin-art-${size}`}
      data-state={state}
      aria-hidden={stage ? undefined : true}
      aria-busy={stage && state === "loading" ? true : undefined}
    >
      {failed ? (
        <span className="skin-art-failure" role={stage ? "status" : undefined}>
          <ImageOff size={stage ? 22 : 16} aria-hidden="true" />
          {stage ? (
            <>
              <strong>预览图加载失败</strong>
              <span>请检查网络连接后重试。</span>
              {onRetry && (
                <button type="button" className="secondary" onClick={onRetry}>
                  <RotateCw size={14} aria-hidden="true" />
                  重新加载
                </button>
              )}
            </>
          ) : (
            <span>加载失败</span>
          )}
        </span>
      ) : (
        <img
          src={url}
          alt={alt}
          loading={stage ? "eager" : "lazy"}
          decoding="async"
          draggable={false}
          onLoad={(event) => {
            const image = event.currentTarget;
            const reveal = () => setLoadedUrl(url);
            // Reveal only a decoded frame, so the fade never starts on a blank box.
            if (typeof image.decode === "function")
              void image.decode().then(reveal, reveal);
            else reveal();
          }}
          onError={() => onFail(url)}
        />
      )}
    </span>
  );
}

function MarketState({
  icon,
  title,
  text,
  detail,
  action,
  onAction,
  alert = false,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  detail?: string;
  action?: string;
  onAction?: () => void;
  alert?: boolean;
}) {
  return (
    <div className="skin-market-state" role={alert ? "alert" : undefined}>
      <span className="skin-market-state-icon" aria-hidden="true">
        {icon}
      </span>
      <h2>{title}</h2>
      <p>{text}</p>
      {detail && (
        <p className="skin-market-state-detail" title={detail}>
          详细信息：{detail}
        </p>
      )}
      {action && onAction && (
        <button type="button" className="secondary" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}

const APPEARANCE_LABEL: Record<string, string> = {
  dark: "深色",
  light: "浅色",
  dual: "深浅双模式",
};

function appearanceLabel(skin: CatalogSkin) {
  return skin.appearance ? (APPEARANCE_LABEL[skin.appearance] ?? "") : "";
}

function skinStatus(skin: CatalogSkin) {
  if (skin.applied) return "当前外观";
  if (skin.installed) return "已安装";
  return "可下载安装";
}

/** Shown when a skin ships no preview image: a neutral window outline. */
function SkinMock({ skin }: { skin: CatalogSkin }) {
  return (
    <span
      className={`skin-mock ${skinToneClass(skin)}`}
      data-appearance={skin.appearance ?? undefined}
      aria-hidden="true"
    >
      <span className="skin-mock-bar">
        <i />
        <i />
        <i />
      </span>
      <span className="skin-mock-body">
        <span className="skin-mock-side">
          <i />
          <i />
          <i />
          <i />
        </span>
        <span className="skin-mock-main">
          <i />
          <i />
          <i />
          <i />
        </span>
      </span>
    </span>
  );
}

function MarketSkeleton() {
  return (
    <div className="skin-layout" aria-busy="true">
      <div className="skin-detail">
        <div className="skin-preview" aria-hidden="true">
          <span className="skin-art skin-art-stage" data-state="loading" />
        </div>
        <p className="skin-market-status" role="status">
          正在读取皮肤目录…
        </p>
      </div>
      <div className="skin-list" aria-hidden="true">
        {Array.from({ length: SKELETON_CARDS }, (_, index) => (
          <span className="skin-card-skeleton" key={index}>
            <span className="skin-art skin-art-thumb" data-state="loading" />
            <span className="skin-lines">
              <i />
              <i />
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

const LIST_TITLE: Record<Filter, string> = {
  featured: "精选皮肤",
  installed: "已安装的皮肤",
  dark: "深色皮肤",
  light: "浅色皮肤",
};

export default function AppearanceView({
  enabled,
  onRequestSkinAction,
}: {
  enabled: boolean;
  onRequestSkinAction: (action: { label: string; execute: () => void }) => void;
}) {
  const designPreview = isAppearanceDesignPreview();
  const [failedPreviews, setFailedPreviews] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const markFailed = useCallback(
    (url: string) =>
      setFailedPreviews((current) =>
        current.has(url) ? current : new Set(current).add(url),
      ),
    [],
  );
  const retryPreview = (url: string) =>
    setFailedPreviews((current) => {
      if (!current.has(url)) return current;
      const next = new Set(current);
      next.delete(url);
      return next;
    });
  const [skins, setSkins] = useState<CatalogSkin[]>(() =>
    designPreview ? [...APPEARANCE_DESIGN_SAMPLE] : [],
  );
  const [selectedId, setSelectedId] = useState(() =>
    designPreview ? APPEARANCE_DESIGN_SAMPLE[0].id : "",
  );
  const [filter, setFilter] = useState<Filter>(() =>
    designPreview ? "installed" : "featured",
  );
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useLightweightCloseBlocker(Boolean(busy));
  const [error, setError] = useState("");
  // Start as loading so the first frame never claims the catalog is empty.
  const [loading, setLoading] = useState(() => enabled && runningInTauri);
  const load = async () => {
    if (!runningInTauri) {
      if (designPreview) return;
      setSkins([]);
      setSelectedId("");
      setError("");
      return;
    }
    try {
      setLoading(true);
      setError("");
      const result = await invoke<CatalogSkin[]>("list_skin_catalog");
      setSkins(result);
      setSelectedId((id) =>
        id && result.some((item) => item.id === id)
          ? id
          : (result[0]?.id ?? ""),
      );
    } catch (reason) {
      // Installed and applied flags may be stale after a failed refresh.
      setSkins([]);
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (enabled) void load();
  }, [enabled]);
  const needle = query.trim().toLowerCase();
  const visibleSkins = skins.filter((skin) => {
    if (filter === "installed" && !skin.installed) return false;
    if (
      filter === "dark" &&
      skin.appearance !== "dark" &&
      skin.appearance !== "dual"
    )
      return false;
    if (
      filter === "light" &&
      skin.appearance !== "light" &&
      skin.appearance !== "dual"
    )
      return false;
    if (!needle) return true;
    return `${skin.name} ${skin.author ?? ""} ${skin.description ?? ""}`
      .toLowerCase()
      .includes(needle);
  });
  const selected =
    visibleSkins.find((item) => item.id === selectedId) ??
    visibleSkins[0] ??
    null;
  const applied = skins.find((skin) => skin.applied) ?? null;
  const installedCount = skins.filter((skin) => skin.installed).length;
  // The design preview has no backend, so every write stays disabled there.
  const writesLocked = Boolean(busy) || designPreview;
  const run = async (
    label: string,
    command: string,
    args?: Record<string, unknown>,
  ) => {
    try {
      setBusy(label);
      await invoke(command, args);
      toast.success(`${label}完成`);
      await load();
    } catch (reason) {
      toast.error(`${label}失败`, { description: String(reason) });
    } finally {
      setBusy(null);
    }
  };
  const importLocal = async () => {
    const path = await settingsApi.openSkinFileDialog();
    if (path) await run("导入皮肤", "import_skin_package", { path });
  };
  if (!enabled) return <Empty label="此版本暂未开放 Codex 皮肤。" />;

  const stateIcon = <Palette size={22} strokeWidth={1.6} />;
  const showCatalog = runningInTauri || designPreview;
  let body: ReactNode;
  if (!showCatalog) {
    body = (
      <MarketState
        icon={stateIcon}
        title="浏览器预览不读取皮肤目录"
        text="请在桌面应用中查看真实皮肤。"
      />
    );
  } else if (loading && !skins.length) {
    body = <MarketSkeleton />;
  } else if (error) {
    body = (
      <MarketState
        alert
        icon={<WifiOff size={22} strokeWidth={1.6} />}
        title="皮肤目录读取失败"
        text="请检查网络连接后重试。"
        detail={error}
        action="重试"
        onAction={() => void load()}
      />
    );
  } else if (!skins.length) {
    body = (
      <MarketState
        icon={stateIcon}
        title="皮肤目录暂无内容"
        text="目前没有可下载的皮肤，可以稍后点「重新读取」，或导入本地皮肤包。"
      />
    );
  } else if (!selected) {
    body = needle ? (
      <MarketState
        icon={stateIcon}
        title="没有匹配的皮肤"
        text={`没有名称、作者或说明包含「${query.trim()}」的皮肤。`}
        action="清除搜索"
        onAction={() => setQuery("")}
      />
    ) : (
      <MarketState
        icon={stateIcon}
        title={
          filter === "installed"
            ? "还没有安装皮肤"
            : filter === "dark"
              ? "暂无深色皮肤"
              : "暂无浅色皮肤"
        }
        text={
          filter === "installed"
            ? "在精选中下载安装皮肤后，会显示在这里。"
            : "皮肤目录中暂时没有这类外观的皮肤。"
        }
        action="查看精选"
        onAction={() => setFilter("featured")}
      />
    );
  } else {
    const selectedUrl = selected.preview
      ? skinPreviewUrl(selected.preview)
      : "";
    const tone = appearanceLabel(selected);
    body = (
      <>
        <div className="skin-layout">
          <article className="skin-detail" aria-label="皮肤详情">
            <header className="skin-detail-head">
              <h2>{selected.name}</h2>
              {selected.description && <p>{selected.description}</p>}
              <p className="skin-detail-meta">
                v{selected.version}
                {selected.author && ` · ${selected.author}`} ·{" "}
                {skinStatus(selected)}
              </p>
            </header>
            <div className="skin-preview" key={selected.id}>
              {selectedUrl ? (
                <SkinArt
                  url={selectedUrl}
                  alt={`${selected.name} 预览`}
                  size="stage"
                  failed={failedPreviews.has(selectedUrl)}
                  onFail={markFailed}
                  onRetry={() => setFailedPreviews(new Set())}
                />
              ) : (
                <span className="skin-art skin-art-stage" data-state="mock">
                  <SkinMock skin={selected} />
                </span>
              )}
            </div>
            <dl className="skin-facts">
              <div>
                <dt>外观</dt>
                <dd>{tone || "未标注"}</dd>
              </div>
              <div>
                <dt>完整性</dt>
                <dd>
                  <ShieldCheck size={13} aria-hidden="true" />
                  安装前校验 SHA-256
                </dd>
              </div>
              <div>
                <dt>应用范围</dt>
                <dd>Codex 窗口的配色与圆角</dd>
              </div>
            </dl>
          </article>
          <aside className="skin-list" aria-label="皮肤列表">
            <header className="skin-list-head">
              <h2>{LIST_TITLE[filter]}</h2>
              <p>{visibleSkins.length} 个</p>
            </header>
            <div className="skin-list-rows">
              {visibleSkins.map((skin) => {
                const url = skin.preview ? skinPreviewUrl(skin.preview) : "";
                const active = skin.id === selected.id;
                return (
                  <button
                    key={skin.id}
                    type="button"
                    className={active ? "active" : ""}
                    aria-pressed={active}
                    onClick={() => {
                      setSelectedId(skin.id);
                      // Choosing a skin whose image failed doubles as its retry.
                      if (url) retryPreview(url);
                    }}
                  >
                    {url ? (
                      <SkinArt
                        url={url}
                        alt=""
                        size="thumb"
                        failed={failedPreviews.has(url)}
                        onFail={markFailed}
                      />
                    ) : (
                      <span
                        className={`skin-card-miniature ${skinToneClass(skin)}`}
                        data-appearance={skin.appearance ?? undefined}
                        aria-hidden="true"
                      />
                    )}
                    <span className="skin-row-text">
                      <b>{skin.name}</b>
                      <small>
                        {[
                          skin.author,
                          appearanceLabel(skin),
                          `v${skin.version}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    </span>
                    {skin.applied ? (
                      <em className="skin-row-state is-applied">使用中</em>
                    ) : skin.installed ? (
                      <em className="skin-row-state">已安装</em>
                    ) : (
                      <ChevronRight
                        className="skin-row-chevron"
                        size={14}
                        aria-hidden="true"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </aside>
        </div>
        <div className="skin-actionbar">
          <p>
            {selected.installed
              ? "应用皮肤会关闭并重新启动 Codex；正在进行的会话会在重启后丢失上下文。"
              : "下载后会先校验皮肤包，再安装到本机；安装后可以试穿或应用。"}
          </p>
          <div className="skin-actions">
            <button
              type="button"
              className="secondary"
              onClick={() =>
                onRequestSkinAction({
                  label: "恢复默认外观",
                  execute: () =>
                    void run("恢复默认", "restore_skin_package", {
                      confirm: true,
                    }),
                })
              }
              disabled={writesLocked}
            >
              恢复默认
            </button>
            {selected.installed && !selected.applied && (
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  onRequestSkinAction({
                    label: "试穿皮肤",
                    execute: () =>
                      void run("试穿", "try_skin_package", {
                        skinId: selected.id,
                        confirm: true,
                      }),
                  })
                }
                disabled={writesLocked}
              >
                试穿
              </button>
            )}
            {selected.installed ? (
              <button
                type="button"
                className="primary"
                onClick={() =>
                  onRequestSkinAction({
                    label: selected.applied ? "重新应用皮肤" : "应用皮肤",
                    execute: () =>
                      void run("应用皮肤", "apply_skin_package", {
                        skinId: selected.id,
                        confirm: true,
                      }),
                  })
                }
                disabled={writesLocked}
              >
                {selected.applied ? "重新应用" : "应用并重启"}
              </button>
            ) : (
              <button
                type="button"
                className="primary skin-install-action"
                onClick={() =>
                  void run("下载安装", "install_catalog_skin", {
                    skinId: selected.id,
                  })
                }
                disabled={writesLocked}
              >
                <Download size={14} aria-hidden="true" />
                {busy === "下载安装" ? "正在下载…" : "下载并安装"}
              </button>
            )}
          </div>
        </div>
      </>
    );
  }

  const summary =
    showCatalog && skins.length
      ? `Codex 窗口皮肤 · ${installedCount} 个已安装 · 当前使用 ${applied?.name ?? "默认外观"}`
      : "Codex 窗口皮肤";

  return (
    <section className="skin-market-reference">
      <header className="skin-market-heading">
        <div>
          <h1>外观</h1>
          <p>{summary}</p>
        </div>
        <div className="skin-heading-actions">
          <button
            type="button"
            className="secondary skin-import"
            onClick={() => void importLocal()}
            disabled={writesLocked || !runningInTauri}
          >
            导入本地
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void load()}
            disabled={loading || !runningInTauri}
          >
            重新读取
          </button>
        </div>
      </header>
      {showCatalog && (
        <div className="skin-toolbar">
          <div className="skin-filter-tabs" aria-label="筛选皮肤">
            {FILTERS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={filter === id ? "is-active" : ""}
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="skin-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={query}
              placeholder="搜索皮肤"
              aria-label="搜索皮肤"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
      )}
      {body}
      <p className="skin-footnote">
        <Info size={13} aria-hidden="true" />
        皮肤不影响线路、凭据与代理行为。
      </p>
    </section>
  );
}
