import "./AppearanceView.css";
import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Download,
  ImageOff,
  Palette,
  RotateCw,
  ShieldCheck,
  WifiOff,
} from "lucide-react";
import { toast } from "sonner";
import { Empty } from "@/components/Empty";
import { settingsApi } from "@/lib/api/settings";

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

function MarketSkeleton() {
  return (
    <div className="skin-layout" aria-busy="true">
      <div className="skin-list" aria-hidden="true">
        {Array.from({ length: SKELETON_CARDS }, (_, index) => (
          <span className="skin-card-skeleton" key={index}>
            <span className="skin-art skin-art-thumb" data-state="loading" />
            <span className="skin-lines">
              <i />
              <i />
              <i />
            </span>
          </span>
        ))}
      </div>
      <div className="skin-detail">
        <div className="skin-preview" aria-hidden="true">
          <span className="skin-art skin-art-stage" data-state="loading" />
        </div>
        <div className="skin-detail-footer">
          <p className="skin-market-status" role="status">
            正在读取皮肤目录…
          </p>
        </div>
      </div>
    </div>
  );
}

export default function AppearanceView({
  enabled,
  onRequestSkinAction,
}: {
  enabled: boolean;
  onRequestSkinAction: (action: { label: string; execute: () => void }) => void;
}) {
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
  const [skins, setSkins] = useState<CatalogSkin[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [filter, setFilter] = useState<Filter>("featured");
  const [busy, setBusy] = useState<string | null>(null);
  useLightweightCloseBlocker(Boolean(busy));
  const [error, setError] = useState("");
  // Start as loading so the first frame never claims the catalog is empty.
  const [loading, setLoading] = useState(() => enabled && runningInTauri);
  const load = async () => {
    if (!runningInTauri) {
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
  const visibleSkins = skins.filter((skin) => {
    if (filter === "installed") return skin.installed;
    if (filter === "dark") {
      return skin.appearance === "dark" || skin.appearance === "dual";
    }
    if (filter === "light") {
      return skin.appearance === "light" || skin.appearance === "dual";
    }
    return true;
  });
  const selected =
    visibleSkins.find((item) => item.id === selectedId) ??
    visibleSkins[0] ??
    null;
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
    const path = await settingsApi.openFileDialog();
    if (path) await run("导入皮肤", "import_skin_package", { path });
  };
  if (!enabled) return <Empty label="此版本暂未开放 Codex 皮肤。" />;

  const stateIcon = <Palette size={22} strokeWidth={1.6} />;
  let body: ReactNode;
  if (!runningInTauri) {
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
        text="目前没有可下载的皮肤，可以稍后再来看看，或导入本地皮肤包。"
        action="重新读取"
        onAction={() => void load()}
      />
    );
  } else if (!selected) {
    body = (
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
    body = (
      <div className="skin-layout">
        <aside className="skin-list" aria-label="皮肤列表">
          {visibleSkins.map((skin) => {
            const url = skin.preview ? skinPreviewUrl(skin.preview) : "";
            return (
              <button
                key={skin.id}
                type="button"
                className={skin.id === selected.id ? "active" : ""}
                aria-pressed={skin.id === selected.id}
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
                    aria-hidden="true"
                  >
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                )}
                <span>
                  <b>{skin.name}</b>
                  <small>
                    {skin.description || `皮肤包 · ${skin.version}`}
                  </small>
                  <code>v{skin.version}</code>
                  {skin.installed && (
                    <em>{skin.applied ? "当前外观" : "已安装"}</em>
                  )}
                </span>
              </button>
            );
          })}
        </aside>
        <article className="skin-detail">
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
              <span className="skin-art skin-art-stage" data-state="failed">
                <span className="skin-art-failure">
                  <ImageOff size={22} aria-hidden="true" />
                  <strong>暂无预览图</strong>
                </span>
              </span>
            )}
          </div>
          <div className="skin-detail-footer">
            <div>
              <h2>{selected.name}</h2>
              {selected.description && <p>{selected.description}</p>}
              <p className="skin-detail-meta">
                v{selected.version}
                {selected.author && ` · ${selected.author}`} ·{" "}
                {selected.applied
                  ? "当前外观"
                  : selected.installed
                    ? "已安装"
                    : "可下载安装"}
              </p>
            </div>
            <div className="skin-actions">
              {!selected.installed && (
                <button
                  className="primary skin-install-action"
                  onClick={() =>
                    void run("下载安装", "install_catalog_skin", {
                      skinId: selected.id,
                    })
                  }
                  disabled={Boolean(busy)}
                >
                  <Download size={14} aria-hidden="true" />
                  {busy === "下载安装" ? "正在下载…" : "下载并安装"}
                </button>
              )}
              {selected.installed && (
                <button
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
                  disabled={Boolean(busy)}
                >
                  {selected.applied ? "重新应用" : "应用"}
                </button>
              )}
              {selected.installed && !selected.applied && (
                <button
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
                  disabled={Boolean(busy) || !selected.installed}
                >
                  试穿
                </button>
              )}
              <button
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
                disabled={Boolean(busy)}
              >
                恢复默认
              </button>
            </div>
          </div>
          <p className="integrity">
            <ShieldCheck size={16} /> 皮肤包经过 SHA256 完整性校验。
          </p>
        </article>
      </div>
    );
  }

  return (
    <section className="skin-market-reference">
      <header className="skin-market-heading">
        <div>
          <h1>皮肤市场</h1>
          <p>浏览、预览并安装 Codex 客户端皮肤。</p>
        </div>
        <div className="skin-filter-tabs">
          {FILTERS.map(([id, label]) => (
            <button
              key={id}
              className={filter === id ? "is-active" : ""}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
          <button
            className="skin-import"
            onClick={() => void importLocal()}
            disabled={Boolean(busy)}
          >
            导入本地
          </button>
        </div>
      </header>
      {body}
    </section>
  );
}
