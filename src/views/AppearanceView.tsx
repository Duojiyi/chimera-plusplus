import { useLightweightCloseBlocker } from "@/hooks/useLightweightClose";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Empty } from "@/components/Empty";
import { settingsApi } from "@/lib/api/settings";
import routeGateIcon from "@/assets/icons/chimera-dragon-mark.png";

const runningInTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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
  return preview.startsWith("/")
    ? preview
    : `https://skins.agentsmirror.com/${preview.replace(/^\/+/, "")}`;
}

export default function AppearanceView({
  enabled,
  onRequestSkinAction,
}: {
  enabled: boolean;
  onRequestSkinAction: (action: { label: string; execute: () => void }) => void;
}) {
  const [skins, setSkins] = useState<CatalogSkin[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [filter, setFilter] = useState<
    "featured" | "installed" | "dark" | "light"
  >("featured");
  const [busy, setBusy] = useState<string | null>(null);
  useLightweightCloseBlocker(Boolean(busy));
  const [error, setError] = useState("");
  const load = async () => {
    if (!runningInTauri) {
      setSkins([]);
      setSelectedId("");
      setError("");
      return;
    }
    try {
      setError("");
      const result = await invoke<CatalogSkin[]>("list_skin_catalog");
      setSkins(result);
      setSelectedId((id) =>
        id && result.some((item) => item.id === id)
          ? id
          : (result[0]?.id ?? ""),
      );
    } catch (reason) {
      setError(String(reason));
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
  if (!enabled) return <Empty label="当前产品策略未启用 Codex 皮肤能力。" />;
  return (
    <section className="skin-market-reference">
      <header className="skin-market-heading">
        <div>
          <span className="eyebrow">CODEX 外观</span>
          <h1>皮肤市场</h1>
          <p>浏览、预览并安装 Codex 客户端皮肤。</p>
        </div>
        <div className="skin-filter-tabs">
          {(
            [
              ["featured", "精选"],
              ["installed", "已安装"],
              ["dark", "深色"],
              ["light", "浅色"],
            ] as const
          ).map(([id, label]) => (
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
      <div className="skin-layout">
        <aside className="skin-list">
          {visibleSkins.map((skin) => (
            <button
              key={skin.id}
              className={skin.id === selected?.id ? "active" : ""}
              onClick={() => setSelectedId(skin.id)}
            >
              <span
                className={`skin-card-preview ${skinToneClass(skin)}`}
                aria-hidden="true"
              >
                {skin.preview === routeGateIcon ? (
                  <span className="skin-card-miniature">
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                ) : (
                  <img
                    src={skinPreviewUrl(skin.preview)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                  />
                )}
              </span>
              <span>
                <b>{skin.name}</b>
                <small>{skin.description || `皮肤包 · ${skin.version}`}</small>
                <code>v{skin.version}</code>
                {skin.installed && (
                  <em>{skin.applied ? "已安装" : "已下载"}</em>
                )}
              </span>
            </button>
          ))}
          {!skins.length && !error && (
            <Empty
              label={
                runningInTauri
                  ? "正在读取皮肤目录…"
                  : "浏览器预览不读取皮肤目录，请在桌面应用中查看真实皮肤。"
              }
            />
          )}
          {Boolean(skins.length) && !visibleSkins.length && (
            <Empty label="当前分类暂无皮肤。" />
          )}
          {error && (
            <Empty
              label={`皮肤目录读取失败：${error}`}
              action="重试"
              onAction={() => void load()}
            />
          )}
        </aside>
        <article className="skin-detail">
          {selected ? (
            <>
              <div
                key={selected.id}
                className={`skin-preview skin-preview-image ${skinToneClass(selected)} ${
                  selected.preview === routeGateIcon
                    ? "is-fallback"
                    : "has-catalog-image"
                }`}
              >
                {selected.preview === routeGateIcon ? (
                  <div className="skin-preview-fallback">
                    <aside>
                      <b>CODEX</b>
                      <span>新对话</span>
                      <span>Codex</span>
                      <span>设置</span>
                    </aside>
                    <main>
                      <code>{selected.name} // CODEX ROUTE</code>
                      <div>
                        <b>ChimeraHub 已连接</b>
                        <small>gpt-5.6-sol · 420 ms</small>
                      </div>
                      <footer>
                        给 Codex 发送消息 <i>↑</i>
                      </footer>
                    </main>
                  </div>
                ) : (
                  <img
                    className="skin-catalog-preview-art"
                    src={skinPreviewUrl(selected.preview)}
                    alt={`${selected.name} 预览`}
                    decoding="async"
                  />
                )}
              </div>
              <div className="skin-detail-footer">
                <div>
                  <h2>
                    {selected.name} {selected.description}
                  </h2>
                  <p>
                    {selected.installed
                      ? `已安装 · v${selected.version} · 适配当前 Codex`
                      : `v${selected.version} · 可下载安装`}
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
            </>
          ) : (
            <Empty label="选择一个皮肤查看预览。" />
          )}
        </article>
      </div>
    </section>
  );
}
