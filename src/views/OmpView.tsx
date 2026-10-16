import { useContext, useState, type CSSProperties } from "react";
import { ToolPageActiveContext } from "@/components/RetainedToolPage";
import { PiPluginMarket } from "./PiPluginMarket";
import { OmpProviders } from "./OmpProviders";
import "./ToolView.css";

const tabs = [
  ["routes", "模型线路"],
  ["plugins", "插件市场"],
  ["runtime", "安装与更新"],
] as const;
type Tab = (typeof tabs)[number][0];

export default function OmpView({ native }: { native: boolean }) {
  const [actionsHost, setActionsHost] = useState<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<Tab>("routes");
  const [marketVisited, setMarketVisited] = useState(false);
  const active = useContext(ToolPageActiveContext);
  return (
    <div className="tool-view text-[var(--text-1)] box-border w-full h-full flex flex-col gap-[12px] p-[12px_24px] bg-[var(--bg-surface)] overflow-y-auto">
      {/* Same header as the other tool pages (ToolView); the mark matches the
          sidebar and 管理工具 ("Om"). */}
      <header className="tool-header">
        <div
          className="tool-mark"
          style={{ "--tool-color": "#8B5CF6" } as CSSProperties}
          aria-hidden="true"
        >
          Om
        </div>
        <div className="tool-title">
          <div className="tool-title-row">
            <h1>oh-my-pi</h1>
            <span className="tool-kind">独立配置</span>
          </div>
          <p>管理 OMP 自定义线路与模型，不影响 Pi；默认模型仍在 OMP 中选择。</p>
        </div>
        <div
          ref={setActionsHost}
          className="tool-actions"
          hidden={tab !== "routes"}
          role="group"
          aria-label="oh-my-pi 工具操作"
        />
      </header>
      <nav aria-label="oh-my-pi 管理导航" className="tool-section-nav">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-current={tab === id ? "page" : undefined}
            onClick={() => {
              setTab(id);
              if (id !== "routes") setMarketVisited(true);
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="tool-section-content">
        <ToolPageActiveContext.Provider value={active && tab === "routes"}>
          <div hidden={tab !== "routes"}>
            <OmpProviders native={native} actionsHost={actionsHost} />
          </div>
        </ToolPageActiveContext.Provider>
        {marketVisited && (
          <ToolPageActiveContext.Provider value={active && tab !== "routes"}>
            <div hidden={tab === "routes"}>
              <PiPluginMarket
                native={native}
                runtime="omp"
                panel={tab === "runtime" ? "runtime" : "plugins"}
              />
            </div>
          </ToolPageActiveContext.Provider>
        )}
      </div>
    </div>
  );
}
