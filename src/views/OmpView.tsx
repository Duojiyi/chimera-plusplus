import { useContext, useState } from "react";
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
      <header className="w-full flex items-center gap-[12px]">
        <div
          className="w-[40px] h-[40px] shrink-0 flex items-center justify-center rounded-[8px] bg-[#8B5CF6] text-white text-[12px] font-bold"
          aria-hidden="true"
        >
          OMP
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-[10px]">
            <h1 className="m-0 text-[28px]/[36px] text-[var(--text-1)] font-bold">
              oh-my-pi
            </h1>
            <span className="px-[8px] py-[2px] rounded-full border border-[var(--border-subtle)] text-[12px] text-[var(--text-2)]">
              独立配置
            </span>
          </div>
          <p className="m-0 text-[13px] text-[var(--text-3)]">
            管理 OMP 自定义线路与模型，不影响 Pi；默认模型仍在 OMP 中选择。
          </p>
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
